import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { workerPlacementOperations } from "./placement-dispatch-store.worker.js";

export type WorkerPlacementDispatchStoreOperations = WorkerOperations<
  typeof workerPlacementOperations
>;
