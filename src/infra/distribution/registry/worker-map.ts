/**
 * Distributed Worker Registry for the OpenClaw P2P mesh.
 * Maintains a live map of available worker nodes and their capabilities.
 */
export class WorkerRegistry {
    private workers = new Map<string, { address: string, capabilities: string[], lastSeen: number }>();

    registerWorker(nodeId: string, address: string, capabilities: string[]) {
        console.log(`Registry: Adding worker node ${nodeId} (${address})`);
        this.workers.set(nodeId, { address, capabilities, lastSeen: Date.now() });
    }

    findWorkerForTask(requiredCapability: string) {
        // Logic to return the best available worker node for a specific task
        return Array.from(this.workers.values()).find(w => w.capabilities.includes(requiredCapability));
    }
}
