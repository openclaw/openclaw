import type { WorkerEnvironmentRecord } from "./environment-record.js";
import type { WorkerPlacementMoveIntent } from "./placement-move-intent.js";
import type { WorkerSessionPlacementRecord, WorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerSessionPlacementState } from "./placement-state.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";

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
  pendingResults: ReadonlyMap<string, WorkerWorkspacePendingResult>;
  workspaceJournalOwnerSessionIds: ReadonlySet<string>;
  workspaceResultReconcilingSessionIds: ReadonlySet<string>;
  workspaceRecoveryPendingSessionIds: ReadonlySet<string>;
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

export type WorkerPlacementRecoveryCandidate = {
  sessionId: string;
  environmentId: string | null;
  state?: WorkerSessionPlacementState;
  moveSourceEnvironmentId?: string;
};
