export class WorkerPlacementInventoryChangedError extends Error {
  constructor(message = "Worker placement inventory changed") {
    super(message);
  }
}
