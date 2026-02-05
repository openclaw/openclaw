import type { WorkQueueStore } from "./store.js";

export class WorkQueueService {
  private running = false;

  constructor(private store: WorkQueueStore) {}

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    await this.store.initialize();
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    await this.store.close();
    this.running = false;
  }
}
