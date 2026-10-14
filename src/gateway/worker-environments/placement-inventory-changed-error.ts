export class WorkerPlacementInventoryChangedError extends Error {
  constructor(readonly sessionIds: ReadonlySet<string>) {
    super("Worker placement inventory changed");
  }
}
