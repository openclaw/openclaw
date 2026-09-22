import type { WorkerEnvironmentRecord } from "./environment-record.js";
import type { WorkerPlacementMoveIntent } from "./placement-move-intent.js";
import type { WorkerSessionPlacementRecord, WorkerSessionTurnClaim } from "./placement-record.js";

export type WorkerEnvironmentPlacementFacts = Pick<
  WorkerEnvironmentRecord,
  | "environmentId"
  | "providerId"
  | "profileId"
  | "profileSnapshot"
  | "state"
  | "leaseId"
  | "ownerEpoch"
  | "nodeDeviceId"
  | "attachedSessionIds"
>;

export type WorkerSessionPlacementProjection = {
  placements: ReadonlyMap<string, WorkerSessionPlacementRecord>;
  moves: ReadonlyMap<string, WorkerPlacementMoveIntent>;
  workspaceResultReconcilingSessionIds: ReadonlySet<string>;
  environments: ReadonlyMap<string, WorkerEnvironmentPlacementFacts>;
};

export type WorkerPlacementConflictBinding = {
  placement: Pick<
    WorkerSessionPlacementRecord,
    "sessionId" | "generation" | "environmentId" | "activeOwnerEpoch"
  >;
  claim: WorkerSessionTurnClaim;
};

export type WorkerSessionPlacementReadResult = {
  projection: WorkerSessionPlacementProjection;
  conflictSessionIds: ReadonlySet<string>;
};
