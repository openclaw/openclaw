import type { WorkerPlacementMoveIntent } from "./worker-environments/placement-move-intent.js";
import type { WorkerEnvironmentPlacementFacts } from "./worker-environments/placement-read-projection.types.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

export type SessionRowPlacementFacts = {
  placement: WorkerSessionPlacementRecord | undefined;
  move: WorkerPlacementMoveIntent | undefined;
  environment: WorkerEnvironmentPlacementFacts | undefined;
  workspaceResultReconciling: boolean;
};

export type SessionRowPlacementFactsReader = {
  getProjectionFacts(id: string): SessionRowPlacementFacts | undefined;
};
