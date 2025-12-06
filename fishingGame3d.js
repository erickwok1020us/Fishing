/**
 * Fishing Game 3D Client
 * Adapted from Pudge Wars game3d.js
 * 
 * Preserves:
 * - Three.js scene setup and rendering
 * - Socket.IO connection and events
 * - Snapshot interpolation for fish movement (like opponent movement)
 * - Bullet logic (adapted from knife logic)
 * 
 * New Features:
 * - Turret rotation instead of WASD movement
 * - Click to shoot toward mouse position
 * - Fish rendering with interpolation
 * - Casino-style UI (coins, jackpot, combo)
 * - Betting system (1-1000 per shot)
 */

const CDN_BASE_URL = 'https://pub-2d994ab822d5426bad338ecb218683d8.r2.dev';

const DEBUG = false;

function debugLog(...args) {
    if (DEBUG) {
        console.log(...args);
    }
}

// Fish type visual configurations (colors until 3D models are ready)
const FISH_VISUALS = {
    1: { name: 'Small Fish', color: 0x87CEEB, scale: 0.8 },
    2: { name: 'Clownfish', color: 0xFF6B35, scale: 1.0 },
    3: { name: 'Angelfish', color: 0xFFD700, scale: 1.2 },
    4: { name: 'Butterfly Fish', color: 0xFF69B4, scale: 1.1 },
    5: { name: 'Pufferfish', color: 0x98FB98, scale: 1.5 },
    6: { name: 'Lionfish', color: 0xDC143C, scale: 1.6 },
    7: { name: 'Seahorse', color: 0x9370DB, scale: 1.3 },
    8: { name: 'Shark', color: 0x708090, scale: 2.5 },
    9: { name: 'Manta Ray', color: 0x4169E1, scale: 2.2 },
    10: { name: 'Golden Dragon', color: 0xFFD700, scale: 3.0, isLegendary: true }
};

let socket = null;
let roomCode = null;
let playerId = null;

class FishingGame3D {
    constructor(isMultiplayer = false, isHostPlayer = false) {
        this.isMultiplayer = isMultiplayer;
        this.isHost = isHostPlayer;
        this.lastTime = performance.now();
        
        // Game state
        this.gameState = {
            isRunning: false,
            countdownActive: false
        };
        
        // Player data
        this.myPlayerId = null;
        this.coins = 10000;
        this.currentBet = 10;
        this.combo = 0;
        this.jackpot = 1000;
        
        // Turret
        this.turretX = 0;
        this.turretZ = 55;
        this.turretRotation = 0;
        this.turretMesh = null;
        
        // Fish management with snapshot interpolation (like opponent movement)
        this.fishMeshes = new Map(); // fishId -> mesh
        this.fishSnapshots = new Map(); // fishId -> snapshot array
        this.snapshotLimit = 20;
        this.interpolationDelay = 100; // ms
        this.serverTimeOffset = 0;
        
        // Bullets (adapted from knives)
        this.bullets = [];
        this.bulletMeshes = new Map();
        
        // Other players' turrets
        this.otherTurrets = new Map();
        
        // Mouse position for aiming
        this.mouse = { x: 0, z: 0 };
        this.raycaster = new THREE.Raycaster();
        this.mouseNDC = new THREE.Vector2();
        
        // Network stats for adaptive interpolation
        this.networkStats = {
            lastUpdateTimes: [],
            jitter: 0
        };
        
        // Initialize Three.js
        this.setupThreeJS();
        this.setupLighting();
        this.setupOceanScene();
        this.setupTurret();
        this.setupCamera();
        this.setupEventListeners();
        this.setupMultiplayerEvents();
        this.setupUI();
        
        // Start game loop
        this.gameLoop();
        
        console.log('[FISHING] Game initialized');
    }
    
    setupThreeJS() {
        this.container = document.getElementById('gameCanvas');
        
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x001a33); // Deep ocean blue
        
        this.renderer = new THREE.WebGLRenderer({ 
            antialias: true,
            alpha: true,
            powerPreference: "high-performance"
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.shadowMap.enabled = false;
        
        if (this.container) {
            this.container.appendChild(this.renderer.domElement);
        }
        
        this.camera = new THREE.PerspectiveCamera(
            70, // Wider FOV to see more of the game area and turret above BET UI
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
    }
    
    setupLighting() {
        // Ambient light for underwater feel
        const ambientLight = new THREE.AmbientLight(0x4488aa, 1.5);
        this.scene.add(ambientLight);
        
        // Directional light from above (sunlight through water)
        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
        directionalLight.position.set(0, 50, 0);
        this.scene.add(directionalLight);
        
        // Point lights for casino feel
        const goldLight = new THREE.PointLight(0xFFD700, 0.5, 100);
        goldLight.position.set(0, 20, 0);
        this.scene.add(goldLight);
    }
    
    setupOceanScene() {
        // Ocean floor
        const floorGeometry = new THREE.PlaneGeometry(200, 150);
        const floorMaterial = new THREE.MeshStandardMaterial({ 
            color: 0x0a2a4a,
            roughness: 0.8
        });
        const floor = new THREE.Mesh(floorGeometry, floorMaterial);
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = -5;
        this.scene.add(floor);
        this.oceanFloor = floor;
        
        // Invisible plane for raycasting (to get mouse position in world)
        const raycastPlane = new THREE.PlaneGeometry(200, 150);
        const raycastMaterial = new THREE.MeshBasicMaterial({ 
            visible: false,
            side: THREE.DoubleSide
        });
        this.raycastPlane = new THREE.Mesh(raycastPlane, raycastMaterial);
        this.raycastPlane.rotation.x = -Math.PI / 2;
        this.raycastPlane.position.y = 0;
        this.scene.add(this.raycastPlane);
        
        // Add some coral/rocks for decoration
        this.addDecorations();
        
        // Add water caustics effect (simple version)
        this.addCausticsEffect();
    }
    
    addDecorations() {
        const coralColors = [0xFF6B6B, 0x4ECDC4, 0x45B7D1, 0x96CEB4, 0xFECEA8];
        
        for (let i = 0; i < 15; i++) {
            const geometry = new THREE.ConeGeometry(1 + Math.random() * 2, 3 + Math.random() * 4, 6);
            const material = new THREE.MeshStandardMaterial({ 
                color: coralColors[Math.floor(Math.random() * coralColors.length)]
            });
            const coral = new THREE.Mesh(geometry, material);
            
            coral.position.x = (Math.random() - 0.5) * 160;
            coral.position.z = (Math.random() - 0.5) * 120;
            coral.position.y = -3;
            coral.rotation.x = (Math.random() - 0.5) * 0.3;
            
            this.scene.add(coral);
        }
    }
    
    addCausticsEffect() {
        // Simple animated light rays
        const rayGeometry = new THREE.PlaneGeometry(200, 150);
        const rayMaterial = new THREE.MeshBasicMaterial({
            color: 0x88ccff,
            transparent: true,
            opacity: 0.1,
            side: THREE.DoubleSide
        });
        this.caustics = new THREE.Mesh(rayGeometry, rayMaterial);
        this.caustics.rotation.x = -Math.PI / 2;
        this.caustics.position.y = 10;
        this.scene.add(this.caustics);
    }
    
    setupTurret() {
        // Create turret (cannon) mesh
        const turretGroup = new THREE.Group();
        
        // Base
        const baseGeometry = new THREE.CylinderGeometry(3, 4, 2, 16);
        const baseMaterial = new THREE.MeshStandardMaterial({ 
            color: 0xB8860B,
            metalness: 0.7,
            roughness: 0.3
        });
        const base = new THREE.Mesh(baseGeometry, baseMaterial);
        base.position.y = 1;
        turretGroup.add(base);
        
        // Cannon barrel
        const barrelGeometry = new THREE.CylinderGeometry(0.8, 1.2, 6, 12);
        const barrelMaterial = new THREE.MeshStandardMaterial({ 
            color: 0xDAA520,
            metalness: 0.8,
            roughness: 0.2
        });
        const barrel = new THREE.Mesh(barrelGeometry, barrelMaterial);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.y = 2;
        barrel.position.z = -3;
        turretGroup.add(barrel);
        
        // Decorative ring
        const ringGeometry = new THREE.TorusGeometry(1.5, 0.3, 8, 16);
        const ringMaterial = new THREE.MeshStandardMaterial({ 
            color: 0xFFD700,
            metalness: 0.9,
            roughness: 0.1
        });
        const ring = new THREE.Mesh(ringGeometry, ringMaterial);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 2;
        turretGroup.add(ring);
        
        turretGroup.position.set(this.turretX, 0, this.turretZ);
        this.scene.add(turretGroup);
        this.turretMesh = turretGroup;
    }
    
    setupCamera() {
        // Top-down angled view for fishing game
        // Raised camera position (90 instead of 80) for wider view so turret is visible above BET UI
        this.camera.position.set(0, 90, 65);
        this.camera.lookAt(0, 0, 0);
    }
    
    setupEventListeners() {
        // Mouse move for aiming
        document.addEventListener('mousemove', (e) => {
            this.mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
            this.mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
            
            // Raycast to get world position
            this.raycaster.setFromCamera(this.mouseNDC, this.camera);
            const intersects = this.raycaster.intersectObject(this.raycastPlane);
            
            if (intersects.length > 0) {
                this.mouse.x = intersects[0].point.x;
                this.mouse.z = intersects[0].point.z;
                
                // Update turret rotation to face mouse
                this.updateTurretRotation();
            }
        });
        
        // Click to shoot
        document.addEventListener('click', (e) => {
            if (!this.gameState.isRunning) return;
            if (e.target.closest('.ui-panel')) return; // Don't shoot when clicking UI
            
            this.shoot();
        });
        
        // Keyboard shortcuts for bet amount
        document.addEventListener('keydown', (e) => {
            if (!this.gameState.isRunning) return;
            
            switch(e.key) {
                case '1': this.setBet(1); break;
                case '2': this.setBet(10); break;
                case '3': this.setBet(50); break;
                case '4': this.setBet(100); break;
                case '5': this.setBet(500); break;
                case '6': this.setBet(1000); break;
                case '+':
                case '=':
                    this.setBet(Math.min(1000, this.currentBet * 2));
                    break;
                case '-':
                    this.setBet(Math.max(1, Math.floor(this.currentBet / 2)));
                    break;
            }
        });
        
        // Window resize
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }
    
    updateTurretRotation() {
        if (!this.turretMesh) return;
        
        const dx = this.mouse.x - this.turretX;
        const dz = this.mouse.z - this.turretZ;
        this.turretRotation = Math.atan2(dx, -dz);
        this.turretMesh.rotation.y = this.turretRotation;
    }
    
    setupMultiplayerEvents() {
        if (!socket) return;
        
        // Time sync for interpolation
        socket.on('timeSyncPong', (data) => {
            const now = Date.now();
            const rtt = now - data.clientSendTime;
            const serverTime = data.serverTime + rtt / 2;
            this.serverTimeOffset = this.serverTimeOffset * 0.9 + (now - serverTime) * 0.1;
        });
        
        // Start time sync
        this.startTimeSync();
        
        // Room events
        socket.on('roomCreated', (data) => {
            console.log('[FISHING] Room created:', data);
            this.myPlayerId = data.playerId;
            if (data.turretPosition) {
                this.turretX = data.turretPosition.x;
                this.turretZ = data.turretPosition.z;
                if (this.turretMesh) {
                    this.turretMesh.position.set(this.turretX, 0, this.turretZ);
                }
            }
        });
        
        socket.on('joinSuccess', (data) => {
            console.log('[FISHING] Joined room:', data);
            this.myPlayerId = data.playerId;
            if (data.turretPosition) {
                this.turretX = data.turretPosition.x;
                this.turretZ = data.turretPosition.z;
                if (this.turretMesh) {
                    this.turretMesh.position.set(this.turretX, 0, this.turretZ);
                }
            }
        });
        
        socket.on('gameStart', () => {
            console.log('[FISHING] Game starting!');
            this.startCountdown();
        });
        
        socket.on('allPlayersLoaded', () => {
            console.log('[FISHING] All players loaded');
            this.hideLoadingOverlay();
        });
        
        // Game state updates (like serverGameState in Pudge Wars)
        socket.on('serverGameState', (data) => {
            this.handleServerGameState(data);
        });
        
        // Bullet events
        socket.on('bulletSpawned', (data) => {
            if (data.ownerId !== this.myPlayerId) {
                // Remote player's bullet - create new mesh
                this.createBulletMesh(data);
            } else {
                // Our own bullet - map server bulletId to local predicted bullet
                // Find the closest unconfirmed local bullet to associate with server ID
                let bestBullet = null;
                let bestDistSq = Infinity;
                
                for (const bullet of this.bullets) {
                    if (bullet.userData.serverConfirmed) continue;
                    const dx = bullet.position.x - data.x;
                    const dz = bullet.position.z - data.z;
                    const distSq = dx * dx + dz * dz;
                    if (distSq < bestDistSq) {
                        bestDistSq = distSq;
                        bestBullet = bullet;
                    }
                }
                
                if (bestBullet && bestDistSq < 100) { // Within reasonable distance
                    const oldId = bestBullet.userData.bulletId;
                    bestBullet.userData.bulletId = data.bulletId;
                    bestBullet.userData.velocityX = data.velocityX;
                    bestBullet.userData.velocityZ = data.velocityZ;
                    bestBullet.userData.serverConfirmed = true;
                    
                    // Re-key in bulletMeshes map
                    this.bulletMeshes.delete(oldId);
                    this.bulletMeshes.set(data.bulletId, bestBullet);
                    
                    debugLog('[BULLET] Mapped local bullet to server ID:', oldId, '->', data.bulletId);
                } else {
                    // Fallback: create new bullet if no match found
                    debugLog('[BULLET] No matching local bullet, creating new');
                    this.createBulletMesh(data);
                }
            }
        });
        
        socket.on('bulletDestroyed', (data) => {
            this.removeBullet(data.bulletId);
        });
        
        socket.on('bulletHit', (data) => {
            this.handleBulletHit(data);
        });
        
        // Fish events
        socket.on('fishKilled', (data) => {
            this.handleFishKilled(data);
        });
        
        // Coin events
        socket.on('coinUpdate', (data) => {
            this.coins = data.coins;
            this.updateCoinDisplay();
            this.showCoinChange(data.change, data.reason);
            
            if (data.combo) {
                this.combo = data.combo;
                this.updateComboDisplay();
            }
        });
        
        socket.on('betUpdated', (data) => {
            this.currentBet = data.currentBet;
            this.coins = data.coins;
            this.updateBetDisplay();
            this.updateCoinDisplay();
        });
        
        socket.on('insufficientCoins', (data) => {
            this.showNotification('Not enough coins!', 'error');
        });
        
        // Jackpot events
        socket.on('jackpotWon', (data) => {
            this.handleJackpotWon(data);
        });
        
        // Error handling
        socket.on('hostDisconnected', () => {
            this.showNotification('Host disconnected. Room closed.', 'error');
            this.gameState.isRunning = false;
        });
    }
    
    startTimeSync() {
        if (!socket) return;
        
        let seq = 0;
        setInterval(() => {
            socket.emit('timeSyncPing', {
                seq: seq++,
                clientSendTime: Date.now()
            });
        }, 5000);
        
        // Initial sync
        socket.emit('timeSyncPing', { seq: seq++, clientSendTime: Date.now() });
    }
    
    handleServerGameState(data) {
        const now = Date.now();
        
        // Update server time offset
        if (data.serverTime) {
            const rawOffset = now - data.serverTime;
            this.serverTimeOffset = this.serverTimeOffset * 0.9 + rawOffset * 0.1;
        }
        
        // Update jackpot
        if (data.jackpot !== undefined) {
            this.jackpot = data.jackpot;
            this.updateJackpotDisplay();
        }
        
        // Update fish snapshots for interpolation (like opponent snapshots)
        if (data.fish) {
            for (const fishData of data.fish) {
                let snapshots = this.fishSnapshots.get(fishData.fishId);
                if (!snapshots) {
                    snapshots = [];
                    this.fishSnapshots.set(fishData.fishId, snapshots);
                }
                
                snapshots.push({
                    timestamp: data.serverTime,
                    x: fishData.x,
                    z: fishData.z,
                    rotation: fishData.rotation,
                    velocityX: fishData.velocityX,
                    velocityZ: fishData.velocityZ
                });
                
                if (snapshots.length > this.snapshotLimit) {
                    snapshots.shift();
                }
                
                // Create mesh if doesn't exist
                if (!this.fishMeshes.has(fishData.fishId)) {
                    this.createFishMesh(fishData);
                }
            }
            
            // Remove fish that are no longer in server state
            const serverFishIds = new Set(data.fish.map(f => f.fishId));
            for (const [fishId, mesh] of this.fishMeshes.entries()) {
                if (!serverFishIds.has(fishId)) {
                    this.scene.remove(mesh);
                    this.fishMeshes.delete(fishId);
                    this.fishSnapshots.delete(fishId);
                }
            }
        }
        
        // Update other players' turrets
        if (data.players) {
            for (const playerData of data.players) {
                if (playerData.playerId !== this.myPlayerId) {
                    this.updateOtherTurret(playerData);
                }
            }
        }
        
        // Update network stats
        this.networkStats.lastUpdateTimes.push(now);
        if (this.networkStats.lastUpdateTimes.length > 20) {
            this.networkStats.lastUpdateTimes.shift();
        }
    }
    
    createFishMesh(fishData) {
        const visual = FISH_VISUALS[fishData.typeId] || FISH_VISUALS[1];
        
        // Create fish mesh (placeholder - will be replaced with 3D models)
        const fishGroup = new THREE.Group();
        
        // Body
        const bodyGeometry = new THREE.SphereGeometry(1.5 * visual.scale, 16, 12);
        bodyGeometry.scale(1.5, 0.8, 1);
        const bodyMaterial = new THREE.MeshStandardMaterial({ 
            color: visual.color,
            metalness: 0.3,
            roughness: 0.7
        });
        const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
        fishGroup.add(body);
        
        // Tail
        const tailGeometry = new THREE.ConeGeometry(0.8 * visual.scale, 2 * visual.scale, 4);
        const tailMaterial = new THREE.MeshStandardMaterial({ 
            color: visual.color,
            metalness: 0.3,
            roughness: 0.7
        });
        const tail = new THREE.Mesh(tailGeometry, tailMaterial);
        tail.rotation.z = Math.PI / 2;
        tail.position.x = 2 * visual.scale;
        fishGroup.add(tail);
        
        // Eye
        const eyeGeometry = new THREE.SphereGeometry(0.3 * visual.scale, 8, 8);
        const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const eye = new THREE.Mesh(eyeGeometry, eyeMaterial);
        eye.position.set(-1 * visual.scale, 0.3 * visual.scale, 0.5 * visual.scale);
        fishGroup.add(eye);
        
        // Pupil
        const pupilGeometry = new THREE.SphereGeometry(0.15 * visual.scale, 8, 8);
        const pupilMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
        const pupil = new THREE.Mesh(pupilGeometry, pupilMaterial);
        pupil.position.set(-1.2 * visual.scale, 0.3 * visual.scale, 0.5 * visual.scale);
        fishGroup.add(pupil);
        
        // Legendary glow effect
        if (visual.isLegendary) {
            const glowGeometry = new THREE.SphereGeometry(2.5 * visual.scale, 16, 12);
            const glowMaterial = new THREE.MeshBasicMaterial({
                color: 0xFFD700,
                transparent: true,
                opacity: 0.3
            });
            const glow = new THREE.Mesh(glowGeometry, glowMaterial);
            fishGroup.add(glow);
        }
        
        // Health bar
        const healthBarGroup = this.createHealthBar(fishData.maxHealth);
        healthBarGroup.position.y = 3 * visual.scale;
        fishGroup.add(healthBarGroup);
        fishGroup.userData.healthBar = healthBarGroup;
        fishGroup.userData.maxHealth = fishData.maxHealth;
        fishGroup.userData.health = fishData.health;
        
        fishGroup.position.set(fishData.x, 0, fishData.z);
        fishGroup.rotation.y = fishData.rotation;
        
        this.scene.add(fishGroup);
        this.fishMeshes.set(fishData.fishId, fishGroup);
        
        return fishGroup;
    }
    
    createHealthBar(maxHealth) {
        const group = new THREE.Group();
        
        // Background
        const bgGeometry = new THREE.PlaneGeometry(3, 0.4);
        const bgMaterial = new THREE.MeshBasicMaterial({ 
            color: 0x333333,
            side: THREE.DoubleSide
        });
        const bg = new THREE.Mesh(bgGeometry, bgMaterial);
        group.add(bg);
        
        // Health fill
        const fillGeometry = new THREE.PlaneGeometry(2.8, 0.3);
        const fillMaterial = new THREE.MeshBasicMaterial({ 
            color: 0x00ff00,
            side: THREE.DoubleSide
        });
        const fill = new THREE.Mesh(fillGeometry, fillMaterial);
        fill.position.z = 0.01;
        group.add(fill);
        group.userData.fill = fill;
        
        // Make it face camera
        group.lookAt(this.camera.position);
        
        return group;
    }
    
    updateFishHealthBar(fishMesh, health) {
        if (!fishMesh.userData.healthBar) return;
        
        const fill = fishMesh.userData.healthBar.userData.fill;
        const maxHealth = fishMesh.userData.maxHealth;
        const healthPercent = health / maxHealth;
        
        fill.scale.x = healthPercent;
        fill.position.x = -(1 - healthPercent) * 1.4;
        
        // Color based on health
        if (healthPercent > 0.6) {
            fill.material.color.setHex(0x00ff00);
        } else if (healthPercent > 0.3) {
            fill.material.color.setHex(0xffff00);
        } else {
            fill.material.color.setHex(0xff0000);
        }
        
        fishMesh.userData.health = health;
    }
    
    interpolateFish() {
        const now = Date.now();
        const renderTime = now - this.serverTimeOffset - this.interpolationDelay;
        
        for (const [fishId, snapshots] of this.fishSnapshots.entries()) {
            if (snapshots.length < 2) continue;
            
            const mesh = this.fishMeshes.get(fishId);
            if (!mesh) continue;
            
            // Find surrounding snapshots
            let before = null;
            let after = null;
            
            for (let i = 0; i < snapshots.length - 1; i++) {
                if (snapshots[i].timestamp <= renderTime && snapshots[i + 1].timestamp >= renderTime) {
                    before = snapshots[i];
                    after = snapshots[i + 1];
                    break;
                }
            }
            
            if (before && after) {
                // Interpolate between snapshots
                const t = (renderTime - before.timestamp) / (after.timestamp - before.timestamp);
                const clampedT = Math.max(0, Math.min(1, t));
                
                mesh.position.x = before.x + (after.x - before.x) * clampedT;
                mesh.position.z = before.z + (after.z - before.z) * clampedT;
                
                // Interpolate rotation
                let rotDiff = after.rotation - before.rotation;
                if (rotDiff > Math.PI) rotDiff -= 2 * Math.PI;
                if (rotDiff < -Math.PI) rotDiff += 2 * Math.PI;
                mesh.rotation.y = before.rotation + rotDiff * clampedT;
            } else if (snapshots.length > 0) {
                // Extrapolate from latest snapshot
                const latest = snapshots[snapshots.length - 1];
                const dt = (renderTime - latest.timestamp) / 1000;
                
                if (dt > 0 && dt < 0.5) {
                    mesh.position.x = latest.x + latest.velocityX * dt;
                    mesh.position.z = latest.z + latest.velocityZ * dt;
                }
            }
            
            // Make health bar face camera
            if (mesh.userData.healthBar) {
                mesh.userData.healthBar.lookAt(this.camera.position);
            }
        }
    }
    
    shoot() {
        if (!this.gameState.isRunning) return;
        if (this.coins < this.currentBet) {
            this.showNotification('Not enough coins!', 'error');
            return;
        }
        
        // Create local bullet immediately for responsiveness
        const bulletData = {
            bulletId: Date.now(), // Temporary ID
            ownerId: this.myPlayerId,
            x: this.turretX,
            z: this.turretZ,
            velocityX: Math.sin(this.turretRotation) * 275,
            velocityZ: -Math.cos(this.turretRotation) * 275,
            rotation: this.turretRotation,
            betAmount: this.currentBet
        };
        
        this.createBulletMesh(bulletData);
        
        // Send to server
        if (socket && roomCode) {
            socket.emit('shoot', {
                roomCode,
                targetX: this.mouse.x,
                targetZ: this.mouse.z
            });
        }
    }
    
    createBulletMesh(data) {
        const bulletGroup = new THREE.Group();
        
        // Bullet body (golden sphere)
        const bulletGeometry = new THREE.SphereGeometry(0.5, 8, 8);
        const bulletMaterial = new THREE.MeshStandardMaterial({
            color: 0xFFD700,
            metalness: 0.9,
            roughness: 0.1,
            emissive: 0xFFD700,
            emissiveIntensity: 0.3
        });
        const bullet = new THREE.Mesh(bulletGeometry, bulletMaterial);
        bulletGroup.add(bullet);
        
        // Trail effect
        const trailGeometry = new THREE.ConeGeometry(0.3, 1.5, 6);
        const trailMaterial = new THREE.MeshBasicMaterial({
            color: 0xFFA500,
            transparent: true,
            opacity: 0.6
        });
        const trail = new THREE.Mesh(trailGeometry, trailMaterial);
        trail.rotation.x = Math.PI / 2;
        trail.position.z = 1;
        bulletGroup.add(trail);
        
        bulletGroup.position.set(data.x, 1, data.z);
        bulletGroup.rotation.y = data.rotation;
        
        bulletGroup.userData = {
            bulletId: data.bulletId,
            velocityX: data.velocityX,
            velocityZ: data.velocityZ,
            spawnTime: Date.now(),
            serverConfirmed: !!data.serverConfirmed, // For local predicted bullets, this starts false
            hasHit: false
        };
        
        this.scene.add(bulletGroup);
        this.bullets.push(bulletGroup);
        this.bulletMeshes.set(data.bulletId, bulletGroup);
        
        return bulletGroup;
    }
    
    updateBullets(dt) {
        const now = Date.now();
        const bulletsToRemove = [];
        
        for (const bullet of this.bullets) {
            // Skip bullets that have already hit something
            if (bullet.userData.hasHit) continue;
            
            // Update position
            bullet.position.x += bullet.userData.velocityX * dt;
            bullet.position.z += bullet.userData.velocityZ * dt;
            
            // Remove if out of bounds or too old
            if (Math.abs(bullet.position.x) > 100 || 
                Math.abs(bullet.position.z) > 80 ||
                now - bullet.userData.spawnTime > 5000) {
                bulletsToRemove.push(bullet);
            }
        }
        
        for (const bullet of bulletsToRemove) {
            this.removeBullet(bullet.userData.bulletId);
        }
    }
    
    removeBullet(bulletId) {
        const mesh = this.bulletMeshes.get(bulletId);
        if (mesh) {
            this.scene.remove(mesh);
            this.bulletMeshes.delete(bulletId);
            
            const index = this.bullets.indexOf(mesh);
            if (index > -1) {
                this.bullets.splice(index, 1);
            }
        }
    }
    
    handleBulletHit(data) {
        // Mark bullet as hit immediately to stop movement
        const bulletMesh = this.bulletMeshes.get(data.bulletId);
        if (bulletMesh) {
            bulletMesh.userData.hasHit = true;
            // Move bullet to hit position for visual accuracy
            bulletMesh.position.set(data.hitX, 1, data.hitZ);
        }
        
        // Create fire/spark hit effect (like blood splash in Pudge Wars)
        this.createHitEffect(data.hitX, data.hitZ);
        
        // Play hit sound (placeholder - user will provide actual sound later)
        const hitSound = document.getElementById('hitSound');
        if (hitSound) {
            hitSound.currentTime = 0;
            hitSound.play().catch(() => {});
        }
        
        // Update fish health bar
        const fishMesh = this.fishMeshes.get(data.fishId);
        if (fishMesh) {
            this.updateFishHealthBar(fishMesh, data.fishHealth);
        }
        
        // Remove bullet after a short delay for visual feedback
        setTimeout(() => {
            this.removeBullet(data.bulletId);
        }, 50);
    }
    
    createHitEffect(x, z) {
        // Fire/spark particle burst effect (like blood splash in Pudge Wars)
        const particleCount = 20; // More particles for dramatic effect
        const particles = [];
        
        // Fire colors: orange, red-orange, yellow-orange
        const fireColors = [0xFF4500, 0xFF6600, 0xFF8C00, 0xFFA500, 0xFFD700];
        
        for (let i = 0; i < particleCount; i++) {
            const geometry = new THREE.SphereGeometry(0.3, 4, 4);
            const color = fireColors[Math.floor(Math.random() * fireColors.length)];
            const material = new THREE.MeshBasicMaterial({
                color: color,
                transparent: true,
                opacity: 1
            });
            const particle = new THREE.Mesh(geometry, material);
            
            particle.position.set(x, 1, z);
            particle.userData = {
                velocityX: (Math.random() - 0.5) * 15,
                velocityY: Math.random() * 12 + 6, // Higher upward velocity
                velocityZ: (Math.random() - 0.5) * 15,
                life: 1,
                decay: 0.03 + Math.random() * 0.02 // Varied decay for natural look
            };
            
            this.scene.add(particle);
            particles.push(particle);
        }
        
        // Animate particles
        const animateParticles = () => {
            let allDead = true;
            
            for (const p of particles) {
                if (p.userData.life > 0) {
                    allDead = false;
                    p.position.x += p.userData.velocityX * 0.016;
                    p.position.y += p.userData.velocityY * 0.016;
                    p.position.z += p.userData.velocityZ * 0.016;
                    p.userData.velocityY -= 25 * 0.016; // Gravity
                    p.userData.life -= p.userData.decay;
                    p.material.opacity = p.userData.life;
                    
                    // Scale down as particle fades
                    const scale = 0.5 + p.userData.life * 0.5;
                    p.scale.set(scale, scale, scale);
                }
            }
            
            if (!allDead) {
                requestAnimationFrame(animateParticles);
            } else {
                for (const p of particles) {
                    this.scene.remove(p);
                    p.geometry.dispose();
                    p.material.dispose();
                }
            }
        };
        
        animateParticles();
    }
    
    handleFishKilled(data) {
        // Remove fish mesh
        const fishMesh = this.fishMeshes.get(data.fishId);
        if (fishMesh) {
            // Death animation
            this.createFishDeathEffect(data.x, data.z, data.isLegendary);
            this.scene.remove(fishMesh);
            this.fishMeshes.delete(data.fishId);
            this.fishSnapshots.delete(data.fishId);
        }
        
        // Show reward popup
        if (data.killerId === this.myPlayerId) {
            this.showRewardPopup(data);
        }
    }
    
    createFishDeathEffect(x, z, isLegendary) {
        const color = isLegendary ? 0xFFD700 : 0x00FFFF;
        const particleCount = isLegendary ? 30 : 15;
        
        for (let i = 0; i < particleCount; i++) {
            const geometry = new THREE.SphereGeometry(0.3, 4, 4);
            const material = new THREE.MeshBasicMaterial({
                color: color,
                transparent: true,
                opacity: 1
            });
            const particle = new THREE.Mesh(geometry, material);
            
            particle.position.set(x, 1, z);
            const angle = (i / particleCount) * Math.PI * 2;
            const speed = 10 + Math.random() * 10;
            particle.userData = {
                velocityX: Math.cos(angle) * speed,
                velocityY: Math.random() * 15 + 5,
                velocityZ: Math.sin(angle) * speed,
                life: 1
            };
            
            this.scene.add(particle);
            
            // Animate
            const animate = () => {
                if (particle.userData.life > 0) {
                    particle.position.x += particle.userData.velocityX * 0.016;
                    particle.position.y += particle.userData.velocityY * 0.016;
                    particle.position.z += particle.userData.velocityZ * 0.016;
                    particle.userData.velocityY -= 15 * 0.016;
                    particle.userData.life -= 0.03;
                    particle.material.opacity = particle.userData.life;
                    requestAnimationFrame(animate);
                } else {
                    this.scene.remove(particle);
                }
            };
            animate();
        }
    }
    
    showRewardPopup(data) {
        const popup = document.createElement('div');
        popup.className = 'reward-popup';
        popup.innerHTML = `
            <div class="reward-fish">${data.fishType}</div>
            <div class="reward-amount">+${data.reward}</div>
            ${data.combo > 1 ? `<div class="reward-combo">x${data.comboMultiplier.toFixed(1)} COMBO!</div>` : ''}
            ${data.jackpotWin > 0 ? `<div class="reward-jackpot">JACKPOT! +${data.jackpotWin}</div>` : ''}
        `;
        
        document.body.appendChild(popup);
        
        setTimeout(() => {
            popup.classList.add('fade-out');
            setTimeout(() => popup.remove(), 500);
        }, 2000);
    }
    
    handleJackpotWon(data) {
        this.jackpot = data.newJackpot;
        this.updateJackpotDisplay();
        
        if (data.playerId === this.myPlayerId) {
            this.showJackpotAnimation(data.amount);
        } else {
            this.showNotification(`Player ${data.playerId} won the JACKPOT: ${data.amount}!`, 'info');
        }
    }
    
    showJackpotAnimation(amount) {
        const overlay = document.createElement('div');
        overlay.className = 'jackpot-overlay';
        overlay.innerHTML = `
            <div class="jackpot-text">JACKPOT!</div>
            <div class="jackpot-amount">+${amount}</div>
        `;
        
        document.body.appendChild(overlay);
        
        setTimeout(() => {
            overlay.classList.add('fade-out');
            setTimeout(() => overlay.remove(), 1000);
        }, 3000);
    }
    
    updateOtherTurret(playerData) {
        let turret = this.otherTurrets.get(playerData.playerId);
        
        if (!turret) {
            // Create turret for other player
            turret = this.createOtherTurretMesh(playerData);
            this.otherTurrets.set(playerData.playerId, turret);
        }
        
        turret.rotation.y = playerData.turretRotation;
    }
    
    createOtherTurretMesh(playerData) {
        const turretGroup = new THREE.Group();
        
        // Similar to main turret but different color
        const baseGeometry = new THREE.CylinderGeometry(2.5, 3.5, 1.5, 16);
        const baseMaterial = new THREE.MeshStandardMaterial({ 
            color: 0x8B4513,
            metalness: 0.5,
            roughness: 0.5
        });
        const base = new THREE.Mesh(baseGeometry, baseMaterial);
        base.position.y = 0.75;
        turretGroup.add(base);
        
        const barrelGeometry = new THREE.CylinderGeometry(0.6, 1, 5, 12);
        const barrelMaterial = new THREE.MeshStandardMaterial({ 
            color: 0xCD853F,
            metalness: 0.6,
            roughness: 0.4
        });
        const barrel = new THREE.Mesh(barrelGeometry, barrelMaterial);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.y = 1.5;
        barrel.position.z = -2.5;
        turretGroup.add(barrel);
        
        turretGroup.position.set(playerData.turretX, 0, playerData.turretZ);
        this.scene.add(turretGroup);
        
        return turretGroup;
    }
    
    setBet(amount) {
        const newBet = Math.max(1, Math.min(1000, amount));
        this.currentBet = newBet;
        this.updateBetDisplay();
        
        if (socket && roomCode) {
            socket.emit('setBet', { roomCode, amount: newBet });
        }
    }
    
    setupUI() {
        // Create UI container if not exists
        let uiContainer = document.getElementById('fishingUI');
        if (!uiContainer) {
            uiContainer = document.createElement('div');
            uiContainer.id = 'fishingUI';
            document.body.appendChild(uiContainer);
        }
        
        uiContainer.innerHTML = `
            <div class="ui-panel coins-panel">
                <div class="panel-label">COINS</div>
                <div class="panel-value" id="coinsDisplay">${this.coins}</div>
            </div>
            
            <div class="ui-panel bet-panel">
                <div class="panel-label">BET</div>
                <div class="bet-controls">
                    <button class="bet-btn" onclick="game.setBet(game.currentBet / 2)">-</button>
                    <div class="panel-value" id="betDisplay">${this.currentBet}</div>
                    <button class="bet-btn" onclick="game.setBet(game.currentBet * 2)">+</button>
                </div>
                <div class="bet-presets">
                    <button onclick="game.setBet(1)">1</button>
                    <button onclick="game.setBet(10)">10</button>
                    <button onclick="game.setBet(50)">50</button>
                    <button onclick="game.setBet(100)">100</button>
                    <button onclick="game.setBet(500)">500</button>
                    <button onclick="game.setBet(1000)">MAX</button>
                </div>
            </div>
            
            <div class="ui-panel jackpot-panel">
                <div class="panel-label">JACKPOT</div>
                <div class="panel-value jackpot-value" id="jackpotDisplay">${this.jackpot}</div>
            </div>
            
            <div class="ui-panel combo-panel">
                <div class="panel-label">COMBO</div>
                <div class="panel-value" id="comboDisplay">x${this.combo || 1}</div>
            </div>
        `;
    }
    
    updateCoinDisplay() {
        const display = document.getElementById('coinsDisplay');
        if (display) {
            display.textContent = this.coins.toLocaleString();
        }
    }
    
    updateBetDisplay() {
        const display = document.getElementById('betDisplay');
        if (display) {
            display.textContent = this.currentBet;
        }
    }
    
    updateJackpotDisplay() {
        const display = document.getElementById('jackpotDisplay');
        if (display) {
            display.textContent = this.jackpot.toLocaleString();
        }
    }
    
    updateComboDisplay() {
        const display = document.getElementById('comboDisplay');
        if (display) {
            display.textContent = `x${this.combo || 1}`;
            if (this.combo > 1) {
                display.classList.add('combo-active');
            } else {
                display.classList.remove('combo-active');
            }
        }
    }
    
    showCoinChange(amount, reason) {
        const popup = document.createElement('div');
        popup.className = `coin-change ${amount > 0 ? 'positive' : 'negative'}`;
        popup.textContent = `${amount > 0 ? '+' : ''}${amount}`;
        
        const coinsPanel = document.querySelector('.coins-panel');
        if (coinsPanel) {
            coinsPanel.appendChild(popup);
            setTimeout(() => popup.remove(), 1500);
        }
    }
    
    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.classList.add('fade-out');
            setTimeout(() => notification.remove(), 500);
        }, 3000);
    }
    
    startCountdown() {
        this.gameState.countdownActive = true;
        
        const overlay = document.getElementById('countdownOverlay') || document.createElement('div');
        overlay.id = 'countdownOverlay';
        overlay.className = 'countdown-overlay';
        document.body.appendChild(overlay);
        
        let count = 3;
        const updateCountdown = () => {
            if (count > 0) {
                overlay.innerHTML = `<div class="countdown-number">${count}</div>`;
                count--;
                setTimeout(updateCountdown, 1000);
            } else {
                overlay.innerHTML = `<div class="countdown-go">GO!</div>`;
                setTimeout(() => {
                    overlay.style.display = 'none';
                    this.gameState.countdownActive = false;
                    this.gameState.isRunning = true;
                }, 500);
            }
        };
        
        updateCountdown();
    }
    
    hideLoadingOverlay() {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
    }
    
    gameLoop() {
        const currentTime = performance.now();
        let frameTime = (currentTime - this.lastTime) / 1000;
        this.lastTime = currentTime;
        
        if (frameTime > 0.25) frameTime = 0.25;
        
        if (this.gameState.isRunning || this.gameState.countdownActive) {
            // Interpolate fish positions (like opponent interpolation)
            this.interpolateFish();
            
            // Update bullets
            this.updateBullets(frameTime);
            
            // Animate caustics
            if (this.caustics) {
                this.caustics.material.opacity = 0.05 + Math.sin(currentTime * 0.001) * 0.05;
            }
        }
        
        // Render
        this.renderer.render(this.scene, this.camera);
        
        requestAnimationFrame(() => this.gameLoop());
    }
    
    dispose() {
        console.log('[FISHING] Disposing game');
        this.gameState.isRunning = false;
        
        // Clean up meshes
        for (const [, mesh] of this.fishMeshes) {
            this.scene.remove(mesh);
        }
        this.fishMeshes.clear();
        this.fishSnapshots.clear();
        
        for (const bullet of this.bullets) {
            this.scene.remove(bullet);
        }
        this.bullets = [];
        this.bulletMeshes.clear();
    }
}

// Global game instance
let game = null;

// Initialize game
function initFishingGame(isMultiplayer = false, isHost = false) {
    if (game) {
        game.dispose();
    }
    game = new FishingGame3D(isMultiplayer, isHost);
    window.game = game; // For UI button access
    return game;
}

// Socket connection helper
function connectToServer(serverUrl) {
    socket = io(serverUrl, {
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000
    });
    
    socket.on('connect', () => {
        console.log('[FISHING] Connected to server');
    });
    
    socket.on('disconnect', () => {
        console.log('[FISHING] Disconnected from server');
    });
    
    return socket;
}

// Room management
function createRoom(code) {
    roomCode = code;
    socket.emit('createRoom', { roomCode: code });
}

function joinRoom(code) {
    roomCode = code;
    socket.emit('joinRoom', { roomCode: code });
}

function startGame() {
    if (roomCode) {
        socket.emit('startGame', { roomCode });
    }
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FishingGame3D, initFishingGame, connectToServer, createRoom, joinRoom, startGame };
}
