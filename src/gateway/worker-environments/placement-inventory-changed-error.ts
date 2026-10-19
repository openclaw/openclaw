export class WorkerPlacementInventoryChangedError extends Error {
  constructor(
    readonly sessionIds: ReadonlySet<string>,
    message = "Worker placement inventory changed",
  ) {
    super(message);
  }
}
