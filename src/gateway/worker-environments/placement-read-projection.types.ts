import type { WorkerEnvironmentRecord } from "./environment-record.js";
import type { WorkerPlacementMoveIntent } from "./placement-move-intent.types.js";
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
> & { inference?: "worker" };

export type WorkerSessionPlacementProjection = {
  readonly placements: ReadonlyMap<string, Readonly<WorkerSessionPlacementRecord>>;
  readonly moves: ReadonlyMap<string, WorkerPlacementMoveIntent>;
  readonly pendingResults: ReadonlyMap<string, WorkerWorkspacePendingResult>;
  readonly workspaceJournalOwnerSessionIds: ReadonlySet<string>;
  readonly workspaceResultReconcilingSessionIds: ReadonlySet<string>;
  readonly workspaceRecoveryPendingSessionIds: ReadonlySet<string>;
  readonly environments: ReadonlyMap<string, WorkerEnvironmentPlacementFacts>;
};

export type WorkerPlacementConflictBinding = {
  placement: Pick<
    WorkerSessionPlacementRecord,
    "sessionId" | "generation" | "environmentId" | "activeOwnerEpoch"
  >;
  claim: WorkerSessionTurnClaim;
};

export type WorkerSessionPlacementReadResult = {
  readonly projection: WorkerSessionPlacementProjection;
  readonly conflictSessionIds: ReadonlySet<string>;
};

export type WorkerPlacementRecoveryCandidate = {
  sessionId: string;
  environmentId: string | null;
  state?: WorkerSessionPlacementState;
  moveSourceEnvironmentId?: string;
};
