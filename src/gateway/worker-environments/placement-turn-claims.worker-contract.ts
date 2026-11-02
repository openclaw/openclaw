import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { placementTurnClaimOperations } from "./placement-turn-claims.worker.js";

export type PlacementTurnClaimWorkerOperations = WorkerOperations<
  typeof placementTurnClaimOperations
>;
