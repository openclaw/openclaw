import type {
  WorkerSessionPlacementIdentity,
  WorkerSessionPlacementRecord,
} from "./placement-record.js";
import type { WorkerPlacementCancellationTarget } from "./placement-target.js";
import type { RetainedWorkerRecoveryAcceptance } from "./recovery-hold-store.js";
import type {
  WorkerPlacementAuthorization,
  WorkerPlacementReclaimRequest,
} from "./service-contract.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type {
  WorkerWorkspaceConflictReport,
  WorkspaceResultConflictLookup,
} from "./workspace-conflicts.js";

export type WorkerWorkspaceRetentionNotice = Pick<
  RetainedWorkerRecoveryAcceptance,
  "environmentId" | "previousCheckpointRef" | "checkpointRef" | "manifestHash"
> & { message: string };

export type PreparedWorkerWorkspaceRecovery = {
  readonly workspace: WorkerSessionWorkspace;
  assertCurrent: () => void;
  resolveConflict: () => Promise<WorkspaceResultConflictLookup>;
  reportConflict: (report: WorkerWorkspaceConflictReport) => Promise<void>;
  reportFailure: (error: string) => Promise<void>;
  reportRetention?: (notice: WorkerWorkspaceRetentionNotice) => Promise<void>;
};

export type WithPreparedWorkerWorkspaceRecovery = <T>(
  identity: WorkerSessionPlacementIdentity,
  assertCurrent: () => void,
  run: (recovery: PreparedWorkerWorkspaceRecovery) => Promise<T>,
) => Promise<T>;

type WorkerReclaimStartPlacement = Extract<
  WorkerSessionPlacementRecord,
  { state: "draining" | "reclaimed" }
>;
export type WorkerReclaimPlacement = Extract<
  WorkerSessionPlacementRecord,
  { state: "local" | "reclaimed" }
>;

export type WorkerPlacementPendingOperations = {
  isCurrent: () => boolean;
  hasPendingDispatch: () => boolean;
  currentPlacement: () => WorkerPlacementCancellationTarget | undefined;
  completedPlacement: () => WorkerPlacementCancellationTarget | undefined;
  settled: Promise<unknown>;
};

export type WorkerPlacementReclaimBarriers = {
  runReclaimPreparation: (
    params: WorkerPlacementReclaimRequest & {
      authorize?: WorkerPlacementAuthorization;
      beforeDrain?: WorkerPlacementAuthorization;
      pendingOperations?: WorkerPlacementPendingOperations;
      run: (authorize?: WorkerPlacementAuthorization) => Promise<WorkerReclaimPlacement>;
    },
  ) => Promise<WorkerReclaimPlacement>;
  runReclaimBarrier: (
    params: WorkerPlacementReclaimRequest & {
      authorize?: WorkerPlacementAuthorization;
      beforeDrain?: WorkerPlacementAuthorization;
      begin: (assertCurrent?: () => void) => Promise<WorkerReclaimStartPlacement>;
      reclaim: (
        workspace: WorkerSessionWorkspace,
        placement: WorkerReclaimStartPlacement,
        authorize?: WorkerPlacementAuthorization,
      ) => Promise<WorkerReclaimPlacement>;
    },
  ) => Promise<WorkerReclaimPlacement>;
  runFailedReclaimBarrier: (
    params: WorkerPlacementReclaimRequest & {
      /** Recovery is requested by a new turn; fence the old lease without aborting that turn. */
      preserveCurrentAdmission?: true;
      authorize?: WorkerPlacementAuthorization;
      reclaim: (authorize?: WorkerPlacementAuthorization) => Promise<WorkerReclaimPlacement>;
    },
  ) => Promise<WorkerReclaimPlacement>;
};
