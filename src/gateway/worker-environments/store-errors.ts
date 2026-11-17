export class WorkerEnvironmentMutationPendingError extends Error {
  readonly settled: Promise<void>;

  constructor(environmentId: string, settled: Promise<void>) {
    super(
      `Worker environment ${environmentId} has an unsettled mutation; retry after it completes`,
    );
    this.name = "WorkerEnvironmentMutationPendingError";
    this.settled = settled;
  }
}

export class WorkerEnvironmentInventoryClosedError extends Error {
  constructor() {
    super("Worker environment inventory has closed");
    this.name = "WorkerEnvironmentInventoryClosedError";
  }
}
