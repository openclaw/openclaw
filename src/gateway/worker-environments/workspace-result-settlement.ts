import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import { sessionWorkspaceRoot, type WorkerSessionWorkspace } from "./session-workspace.js";
import {
  projectWorkspaceResultConflict,
  type WorkerWorkspaceResultConflict,
} from "./workspace-conflicts.js";
import {
  deleteStagedWorkerWorkspaceResult,
  isWorkerWorkspaceResultCleanupRef,
  moveStagedWorkerWorkspaceResultToCleanup,
} from "./workspace-result-staging.js";

type OwnedWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "active" | "draining" }>;

export function createWorkspaceResultJournal(params: {
  placement: OwnedWorkerPlacement;
  placements: WorkerSessionPlacementStore;
  turnClaim: WorkerSessionTurnClaim;
}) {
  const owner = {
    sessionId: params.placement.sessionId,
    environmentId: params.placement.environmentId,
    ownerEpoch: params.placement.activeOwnerEpoch,
    placementGeneration: params.placement.generation,
  };
  let manifestAccepted = false;
  return {
    adapter: {
      load: () => params.placements.loadWorkspaceReconciliation(owner),
      begin: (next: Parameters<typeof params.placements.beginWorkspaceReconciliation>[1]) =>
        params.placements.beginWorkspaceReconciliation(owner, next),
      commit: (manifestRef: string) => {
        params.placements.updateWorkspaceBaseManifest({ claim: params.turnClaim, manifestRef });
        manifestAccepted = true;
      },
      abort: () => params.placements.abortWorkspaceReconciliation(owner),
    },
    wasAccepted: () => manifestAccepted,
  };
}

type WorkspaceResultFinalizationStore = Pick<
  WorkerSessionPlacementStore,
  | "closeWorkerTurnToolState"
  | "completeWorkspaceResultAndReleaseTurn"
  | "recordWorkspaceResultConflict"
>;

type WorkspaceResultConflictReport = Required<WorkerWorkspaceResultConflict> | { cleared: true };

export async function finalizeWorkspaceResultConflicts(params: {
  placements: WorkspaceResultFinalizationStore;
  turnClaim: WorkerSessionTurnClaim;
  conflictPaths: readonly string[];
  priorConflict: WorkerWorkspaceResultConflict | undefined;
  stagedResultRef: string | null | undefined;
  retainPriorConflict?: boolean;
  report: (report: WorkspaceResultConflictReport) => Promise<void>;
  workspace: WorkerSessionWorkspace;
}): Promise<{
  conflict: Required<WorkerWorkspaceResultConflict> | undefined;
  conflictRetained: boolean;
}> {
  const retainedPriorConflict =
    params.retainPriorConflict && params.conflictPaths.length === 0
      ? params.priorConflict
      : undefined;
  const supersededConflict =
    params.priorConflict &&
    !retainedPriorConflict &&
    (params.conflictPaths.length === 0 ||
      params.priorConflict.stagedResultRef !== params.stagedResultRef)
      ? params.priorConflict
      : undefined;
  if (
    params.workspace.kind === "local" &&
    supersededConflict &&
    supersededConflict.stagedResultRef !== params.stagedResultRef
  ) {
    // Delete the inspectable result before replacing its last durable pointer.
    await deleteStagedWorkerWorkspaceResult({
      root: sessionWorkspaceRoot(params.workspace),
      stagedResultRef: supersededConflict.stagedResultRef,
    });
  }

  let conflict: Required<WorkerWorkspaceResultConflict> | undefined;
  if (params.conflictPaths.length > 0) {
    if (!params.stagedResultRef) {
      throw new Error("Cloud workspace conflict has no staged result reference");
    }
    conflict = projectWorkspaceResultConflict(params.conflictPaths, params.stagedResultRef);
    params.placements.recordWorkspaceResultConflict(params.turnClaim, conflict);
    await params.report(conflict);
  } else if (retainedPriorConflict) {
    params.placements.recordWorkspaceResultConflict(params.turnClaim, retainedPriorConflict);
  } else if (supersededConflict) {
    params.placements.recordWorkspaceResultConflict(params.turnClaim, undefined);
    await params.report({ cleared: true });
  }

  return { conflict, conflictRetained: conflict !== undefined };
}

type StagedWorkspaceResultSettlement = {
  placements: WorkspaceResultFinalizationStore;
  turnClaim: WorkerSessionTurnClaim;
  workspace: WorkerSessionWorkspace;
  stagedResultRef: string | null | undefined;
  conflictRetained: boolean;
  beforeComplete: () => Promise<void>;
  complete?: () => WorkerSessionPlacementRecord;
  afterComplete?: (completed: WorkerSessionPlacementRecord) => Promise<void>;
  validateCompleted?: (completed: WorkerSessionPlacementRecord) => void;
};
export async function settleStagedWorkspaceResult(
  params: StagedWorkspaceResultSettlement,
): Promise<WorkerSessionPlacementRecord> {
  if (params.turnClaim.owner.kind === "worker") {
    await params.placements.closeWorkerTurnToolState(params.turnClaim);
  }
  const cleanupRef =
    params.workspace.kind === "local" && params.stagedResultRef && !params.conflictRetained
      ? isWorkerWorkspaceResultCleanupRef(params.stagedResultRef)
        ? params.stagedResultRef
        : await moveStagedWorkerWorkspaceResultToCleanup({
            root: sessionWorkspaceRoot(params.workspace),
            stagedResultRef: params.stagedResultRef,
          })
      : undefined;
  await params.beforeComplete();
  const completed = params.complete
    ? params.complete()
    : params.placements.completeWorkspaceResultAndReleaseTurn(params.turnClaim);
  params.validateCompleted?.(completed);
  await params.afterComplete?.(completed);
  if (cleanupRef) {
    // Cleanup refs remain discoverable after the SQLite fence disappears.
    await deleteStagedWorkerWorkspaceResult({
      root: sessionWorkspaceRoot(params.workspace),
      stagedResultRef: cleanupRef,
    }).catch(() => undefined);
  }
  return completed;
}
