export class WorkerEnvironmentInventoryClosedError extends Error {
  constructor() {
    super("Worker environment inventory has closed");
    this.name = "WorkerEnvironmentInventoryClosedError";
  }
}
