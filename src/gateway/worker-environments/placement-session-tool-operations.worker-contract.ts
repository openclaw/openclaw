import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { placementSessionToolOperations } from "./placement-session-tool-operations.worker.js";

export type PlacementSessionToolWorkerOperations = WorkerOperations<
  typeof placementSessionToolOperations
>;
