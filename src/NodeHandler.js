var Entity = require('./entity');
var Vector = require('./modules/Vector');

function NodeHandler(gameServer, collisionHandler) {
    this.gameServer = gameServer;
    this.collisionHandler = collisionHandler;
    
    this.currentFood = 0;
}

module.exports = NodeHandler;

NodeHandler.prototype.update = function() {
    // Preset mass decay
    var massDecay = 1 - (this.gameServer.config.playerMassDecayRate * this.gameServer.gameMode.decayMod * 0.025);
    
    // First update client's cells
    for (var i = 0; i < this.gameServer.clients.length; i++) {
        var client = this.gameServer.clients[i];
        if (!client) continue;
        
        // We need to go deeper
        client = client.playerTracker;
        
        client.cellUpdate--;
        if (client.cellUpdate > 0) continue;
        client.cellUpdate = 25;
        
        // Merge override check
        if (client.cells.length <= 1)
            client.mergeOverride = false;
        
        // Add cells and sort them
        var sorted = client.cells.slice(0);
        sorted.sort(function(a, b) {
            return b.mass - a.mass;
        });
        
        // Precalculate decay multiplier
        var thisDecay;
        if (this.gameServer.config.serverTeamingAllowed == 0) {
            // Anti-teaming is on
            var teamMult = (client.massDecayMult - 1) / 1111 + 1; // Calculate anti-teaming multiplier for decay
            thisDecay = 1 - (1 - massDecay * (1 / teamMult)); // Apply anti-teaming multiplier
        } else {
            // Anti-teaming is off
            thisDecay = massDecay;
        }
        
        // Update the cells
        for (var j = 0; j < sorted.length; j++) {
            var cell = sorted[j];
            if (!cell) continue;
            
            // Move engine
            cell.moveEngineTick();
            this.gameServer.gameMode.onCellMove(cell, this.gameServer);
            
            // Collide if required
            if (cell.collisionRestoreTicks <= 0) {
                for (var k = 0; k < sorted.length; k++) {
                    if (!sorted[k]) continue;
                    
                    if (sorted[k].collisionRestoreTicks > 0 ||
                        sorted[k].shouldRecombine && cell.shouldRecombine) continue;

                    this.collisionHandler.pushApart(cell, sorted[k]);
                }
            }
            
            // Collision restoring
            if (cell.collisionRestoreTicks > 0) cell.collisionRestoreTicks -= 0.75;
            
            // Eating
            cell.eat();
            
            // Recombining
            if (sorted.length > 1) cell.recombineTicks += 0.025;
            else cell.recombineTicks = 0;
            cell.calcMergeTime(this.gameServer.config.playerRecombineTime);
            
            // Mass decay
            if (cell.mass >= this.gameServer.config.playerMinMassDecay)
                cell.mass *= thisDecay;
        }
    }
    
    // Client cells have been finished, now go the other cells
    for (var i = 0; i < this.gameServer.nonPlayerNodes.length; i++) {
        var node = this.gameServer.nonPlayerNodes[i];
        if (!node) continue;
        
        node.ticksLeft--;
        if (node.ticksLeft > 0) continue;
        node.ticksLeft = 25;
        
        node.moveEngineTick();
        node.eat();
    }
    
    // Spawning food & viruses
    var foodSpawn = Math.min(this.gameServer.config.foodMaxAmount - this.gameServer.nodesFood.length,
        this.gameServer.config.foodSpawnAmount);
    this.addFood(foodSpawn);
    
    var virusSpawn = this.gameServer.config.virusMinAmount - this.gameServer.nodesVirus.length;
    this.addViruses(virusSpawn);
};

NodeHandler.prototype.addFood = function(n) {
    if (n <= 0) return;
    for (var i = 0; i < n; i++) {
        var food = new Entity.Food(
            this.gameServer.getNextNodeId(),
            null,
            this.getRandomPosition(), // getRandomSpawn at start will lock the server in a loop
            this.gameServer.config.foodMass,
            this.gameServer
        );
        food.insertedList = this.gameServer.nodesFood;
        food.setColor(this.gameServer.getRandomColor());
        
        this.gameServer.addNode(food);
        this.gameServer.nodesFood.push(food);
    }
};

NodeHandler.prototype.addViruses = function(n) {
    if (n <= 0) return;
    for (var i = 0; i < n; i++) {
        var virus = new Entity.Virus(
            this.gameServer.getNextNodeId(),
            null,
            this.getRandomSpawn(),
            this.gameServer.config.virusStartMass,
            this.gameServer
        );
        
        this.gameServer.addNode(virus);
    }
};

NodeHandler.prototype.getRandomPosition = function() {
    var xSum = this.gameServer.config.borderRight - this.gameServer.config.borderLeft;
    var ySum = this.gameServer.config.borderBottom - this.gameServer.config.borderTop;
    return new Vector(
        Math.floor(Math.random() * xSum + this.gameServer.config.borderLeft),
        Math.floor(Math.random() * ySum + this.gameServer.config.borderTop)
    );
};

NodeHandler.prototype.getRandomSpawn = function() {
    // Find a random pellet
    var pellet;
    while (true) {
        var randomIndex = Math.ceil(Math.random() * this.gameServer.nodesFood.length);
        var node = this.gameServer.nodesFood[randomIndex];
        if (!node) continue;
        if (node.inRange) continue;
        
        pellet = node;
        break;
    }
    
    // Generate random angle and distance
    var randomAngle = Math.random() * 6.28;
    var randomDist = Math.random() * 100;
    
    // Apply angle and distance to a clone of pellet's pos
    return new Vector(
        pellet.position.x + Math.sin(randomAngle) * randomDist,
        pellet.position.y + Math.cos(randomAngle) * randomDist
    );
};

NodeHandler.prototype.shootVirus = function(parent) {
    var parentPos = {
        x: parent.position.x,
        y: parent.position.y,
    };

    var newVirus = new Entity.Virus(
        this.gameServer.getNextNodeId(),
        null,
        parentPos,
        this.gameServer.config.virusStartMass,
        this.gameServer
    );
    
    newVirus.moveEngine = new Vector(
        Math.sin(parent.shootAngle) * 115,
        Math.cos(parent.shootAngle) * 115
    );

    // Add to cell list
    this.gameServer.addNode(newVirus);
};

NodeHandler.prototype.splitCells = function(client) {
    var len = client.cells.length;
    var splitCells = 0; // How many cells have been split
    for (var i = 0; i < len; i++) {
        var cell = client.cells[i];

        var angle = cell.position.angleTo(client.mouse.x, client.mouse.y);
        if (angle == 0 || isNaN(angle)) angle = Math.PI / 2;

        if (this.createPlayerCell(client, cell, angle, cell.mass / 2) == true) splitCells++;
    }
    if (splitCells > 0) client.applyTeaming(1, 2); // Account anti-teaming
};

NodeHandler.prototype.createPlayerCell = function(client, parent, angle, mass) {
    // Returns boolean whether a cell has been split or not. You can use this in the future.

    // Maximum controllable cells
    if (client.cells.length >= this.gameServer.config.playerMaxCells) return false;

    // Minimum mass to split
    if (parent.mass < this.gameServer.config.playerMinMassSplit) return false;
    
    // Create cell
    var newCell = new Entity.PlayerCell(
        this.gameServer.getNextNodeId(),
        client, 
        parent.position.clone(),
        mass,
        this.gameServer
    );
    
    // Set split boost's speed
    var splitSpeed = newCell.getSplittingSpeed();
    newCell.moveEngine = new Vector(
        Math.sin(angle) * splitSpeed,
        Math.cos(angle) * splitSpeed
    );
    
    // Cells won't collide immediately
    newCell.collisionRestoreTicks = 12;
    parent.collisionRestoreTicks = 12;

    parent.mass -= mass; // Remove mass from parent cell

    // Add to node list
    this.gameServer.addNode(newCell);
    return true;
};

NodeHandler.prototype.canEjectMass = function(client) {
    if (typeof client.lastEject == undefined ||
        this.gameServer.time - client.lastEject >= this.gameServer.config.ejectMassCooldown) {
        client.lastEject = this.gameServer.time;
        return true;
    } else
        return false;
};

NodeHandler.prototype.ejectMass = function(client) {
    // Need to fix this
    //if (!this.canEjectMass(client))
        //return;
    for (var i = 0; i < client.cells.length; i++) {
        var cell = client.cells[i];
        if (!cell) continue;
        
        // Double-check just in case
        if (cell.mass < this.gameServer.config.playerMinMassEject ||
            cell.mass < this.gameServer.config.ejectMass) continue;

        var angle = cell.position.angleTo(client.mouse);

        // Randomize angle (creation)
        angle += (Math.random() * 0.1) - 0.05;

        // Get starting position
        var size = cell.getSize() + 16;
        var startPos = new Vector(
            cell.position.x - ((size) * Math.sin(angle)),
            cell.position.y - ((size) * Math.cos(angle))
        );

        // Remove mass from parent cell
        cell.mass -= this.gameServer.config.ejectMassLoss;
        
        // Randomize angle (movement)
        angle += (Math.random() * 0.6) - 0.3;

        // Create cell
        var ejected = new Entity.EjectedMass(
            this.gameServer.getNextNodeId(),
            client,
            startPos,
            this.gameServer.config.ejectMass,
            this.gameServer
        );
        ejected.moveEngine = new Vector(
            Math.sin(angle) * this.gameServer.config.ejectSpeed,
            Math.cos(angle) * this.gameServer.config.ejectSpeed
        );
        ejected.setColor(cell.getColor());

        this.gameServer.nodesEjected.push(ejected);
        this.gameServer.addNode(ejected);
    }
};
