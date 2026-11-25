import { createSubsystemLogger } from "../../logging/subsystem.js";
import { assertRepositoryWorkspaceDiskIdentity } from "../../state/session-repository-workspaces.authority.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import type { RepositoryWorkspaceDiskAuthority } from "../../state/session-repository-workspaces.types.js";
import { settleRepositoryDiskGatewayMove } from "./placement-dispatch-pending-move.js";
import type { WorkerPlacementMoveIntent } from "./placement-move-intent.types.js";
import type { PreparedWorkerWorkspaceRecovery } from "./placement-reclaim-contract.js";
import type { PlacementRecoveryDeps } from "./placement-recovery-contract.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import { isExactAttachedEnvironment } from "./placement-target.js";
import type { PlacementTurnClaimCurrentCheck } from "./placement-turn-claims.types.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";
import { withSessionRepositoryCheckpoint } from "./session-repository-checkpoints.js";
import { sessionWorkspaceRoot, type WorkerSessionWorkspace } from "./session-workspace.js";
import { boundedWorkerError } from "./worker-error.js";
import {
  projectWorkspaceResultConflict,
  type WorkerWorkspaceConflictReport,
  type WorkerWorkspaceResultConflict,
} from "./workspace-conflicts.js";
import {
  adoptStagedWorkerWorkspaceHistory,
  deleteStagedWorkerWorkspaceResult,
  isWorkerWorkspaceResultCleanupRef,
  moveStagedWorkerWorkspaceResultToCleanup,
} from "./workspace-result-staging.js";

const log = createSubsystemLogger("gateway/worker-placement");

export async function adoptReclaimedWorkspaceHistory(
  params: Pick<PreparedWorkerWorkspaceRecovery, "workspace" | "assertCurrent" | "reportNote"> & {
    stagedResultRef: string | null | undefined;
  },
): Promise<void> {
  if (params.workspace.kind === "device-folder" || !params.stagedResultRef) {
    return;
  }
  if (params.workspace.kind === "repository") {
    await withSessionRepositoryCheckpoint(
      {
        workspaceId: params.workspace.repository.workspaceId,
        checkpointRef: params.stagedResultRef,
      },
      async (snapshot) => {
        if (snapshot.gitHistoryNote) {
          await params.reportNote(snapshot.gitHistoryNote);
        }
      },
    );
    return;
  }
  const note = await adoptStagedWorkerWorkspaceHistory({
    root: sessionWorkspaceRoot(params.workspace),
    stagedResultRef: params.stagedResultRef,
    assertCurrent: params.assertCurrent,
  });
  if (note) {
    await params.reportNote(note);
  }
}

export async function resolvePriorWorkspaceResultConflict(
  resolve: PreparedWorkerWorkspaceRecovery["resolveConflict"],
  placement: {
    sessionId: string;
    workspaceResultConflict?: WorkerWorkspaceResultConflict;
  },
): Promise<WorkerWorkspaceResultConflict | undefined> {
  if (placement.workspaceResultConflict) {
    return placement.workspaceResultConflict;
  }
  const lookup = await resolve();
  if (lookup.kind === "conflict") {
    return lookup.conflict;
  }
  if (lookup.kind === "unknown") {
    log.warn(
      `Cloud workspace conflict state unknown sessionId=${boundedWorkerError(placement.sessionId, 128)} reason=${lookup.reason}; preserving prior conflict state`,
    );
    // Undefined means no prior knowledge to finalizeWorkspaceResultConflicts: it cannot
    // clear the retained report or delete its unseen staged ref. The warning signals this.
  }
  return undefined;
}

type OwnedWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "active" | "draining" }>;

export function createWorkspaceResultJournal(params: {
  placement: OwnedWorkerPlacement;
  placements: Pick<
    WorkerSessionPlacementStore,
    | "loadWorkspaceReconciliation"
    | "beginWorkspaceReconciliation"
    | "updateWorkspaceBaseManifest"
    | "abortWorkspaceReconciliation"
  >;
  turnClaim: WorkerSessionTurnClaim;
  assertCurrent?: () => void;
  assertCommitCurrent?: () => void;
  current?: PlacementTurnClaimCurrentCheck;
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
      load: () =>
        params.placements.loadWorkspaceReconciliation(owner, undefined, params.assertCurrent),
      begin: (next: Parameters<typeof params.placements.beginWorkspaceReconciliation>[1]) => {
        params.assertCurrent?.();
        return params.placements.beginWorkspaceReconciliation(owner, next, params.assertCurrent);
      },
      commit: async (manifestRef: string) => {
        (params.assertCommitCurrent ?? params.assertCurrent)?.();
        await params.placements.updateWorkspaceBaseManifest(
          { claim: params.turnClaim, manifestRef },
          params.assertCurrent,
          params.current,
        );
        manifestAccepted = true;
      },
      abort: () => {
        params.assertCurrent?.();
        return params.placements.abortWorkspaceReconciliation(
          owner,
          undefined,
          params.assertCurrent,
        );
      },
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

export async function finalizeWorkspaceResultConflicts(params: {
  assertCurrent: () => void;
  placements: WorkspaceResultFinalizationStore;
  turnClaim: WorkerSessionTurnClaim;
  conflictPaths: readonly string[];
  priorConflict: WorkerWorkspaceResultConflict | undefined;
  stagedResultRef: string | null | undefined;
  retainPriorConflict?: boolean;
  report: (report: WorkerWorkspaceConflictReport) => Promise<void>;
  workspace: WorkerSessionWorkspace;
}): Promise<boolean> {
  params.assertCurrent();
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
      assertCurrent: params.assertCurrent,
    });
  }

  let conflict: Required<WorkerWorkspaceResultConflict> | undefined;
  if (params.conflictPaths.length > 0) {
    if (!params.stagedResultRef) {
      throw new Error("Cloud workspace conflict has no staged result reference");
    }
    conflict = projectWorkspaceResultConflict(params.conflictPaths, params.stagedResultRef);
    params.assertCurrent();
    params.placements.recordWorkspaceResultConflict(params.turnClaim, conflict);
    await params.report(conflict);
  } else if (retainedPriorConflict) {
    params.assertCurrent();
    params.placements.recordWorkspaceResultConflict(params.turnClaim, retainedPriorConflict);
  } else if (supersededConflict) {
    params.assertCurrent();
    params.placements.recordWorkspaceResultConflict(params.turnClaim, undefined);
    await params.report({ cleared: true });
  }

  return conflict !== undefined;
}

type StagedWorkspaceResultSettlement = {
  assertCurrent: () => void;
  placements: WorkspaceResultFinalizationStore;
  turnClaim: WorkerSessionTurnClaim;
  workspace: WorkerSessionWorkspace;
  stagedResultRef: string | null | undefined;
  conflictRetained: boolean;
  closeToolState?: false;
  beforeComplete: () => Promise<void>;
  complete?: () => Promise<WorkerSessionPlacementRecord>;
  afterComplete?: (completed: WorkerSessionPlacementRecord) => Promise<void>;
};
export async function settleStagedWorkspaceResult(
  params: StagedWorkspaceResultSettlement,
): Promise<WorkerSessionPlacementRecord> {
  params.assertCurrent();
  if (params.turnClaim.owner.kind === "worker" && params.closeToolState !== false) {
    await params.placements.closeWorkerTurnToolState(params.turnClaim);
    params.assertCurrent();
  }
  const cleanupRef =
    params.workspace.kind === "local" && params.stagedResultRef && !params.conflictRetained
      ? isWorkerWorkspaceResultCleanupRef(params.stagedResultRef)
        ? params.stagedResultRef
        : await moveStagedWorkerWorkspaceResultToCleanup({
            root: sessionWorkspaceRoot(params.workspace),
            stagedResultRef: params.stagedResultRef,
            assertCurrent: params.assertCurrent,
          })
      : undefined;
  params.assertCurrent();
  await params.beforeComplete();
  // Explicit completion owns settlement after its final privileged effect commits.
  if (!params.complete) {
    params.assertCurrent();
  }
  const completed = params.complete
    ? await params.complete()
    : await params.placements.completeWorkspaceResultAndReleaseTurn(
        params.turnClaim,
        params.assertCurrent,
      );
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

export async function resolvePendingResultWorkspace(
  deps: Pick<PlacementRecoveryDeps, "resolveWorkspace">,
  placement: WorkerSessionPlacementRecord,
  pending: WorkerWorkspacePendingResult,
  preparedWorkspace?: WorkerSessionWorkspace,
): Promise<WorkerSessionWorkspace> {
  const workspace = preparedWorkspace ?? (await deps.resolveWorkspace(placement));
  if (!pending.repositoryWorkspaceId) {
    return workspace;
  }
  const repository = await getSessionRepositoryWorkspaceStore().get(pending.repositoryWorkspaceId);
  if (
    !repository ||
    repository.agentId !== placement.agentId ||
    repository.sessionKey !== placement.sessionKey ||
    (workspace.kind === "repository" &&
      workspace.repository.workspaceId !== pending.repositoryWorkspaceId)
  ) {
    throw new Error("Pending repository checkpoint lost its exact session workspace owner");
  }
  // An explicit Gateway move may already have bound a local worktree. The
  // result's recorded source still owns its immutable artifact until settlement.
  return { kind: "repository", repository };
}

export async function recoverRepositoryDiskResult(params: {
  deps: PlacementRecoveryDeps;
  placement: OwnedWorkerPlacement;
  pending: WorkerWorkspacePendingResult;
  authority: RepositoryWorkspaceDiskAuthority;
  turnClaim: WorkerSessionTurnClaim;
  workspace: WorkerSessionWorkspace;
  assertCurrent: () => void;
  move?: WorkerPlacementMoveIntent;
  currentWorkspace: WorkerSessionWorkspace;
}): Promise<void> {
  const { deps, placement, pending, authority, turnClaim, workspace, assertCurrent, move } = params;
  const { environments, placements } = deps;
  const gatewayMove =
    move?.target.kind === "gateway" &&
    !move.abandonSource &&
    move.source.environmentId === placement.environmentId &&
    move.source.ownerEpoch === placement.activeOwnerEpoch &&
    move.source.generation + 1 === placement.generation &&
    placement.state === "draining";
  if (gatewayMove && pending.claimId === pending.runId && pending.claimId.startsWith("reclaim-")) {
    await deps.workspaceOperations.run(authority.environmentId, () =>
      settleRepositoryDiskGatewayMove({
        deps,
        placement,
        turnClaim,
        workspace: params.currentWorkspace,
        assertCurrent,
        recovering: true,
      }),
    );
    return;
  }
  const assertDiskCurrent = () => {
    assertCurrent();
    const environment = environments.get(authority.environmentId);
    const current = placements.preparedWorkspaceResultPlacement(turnClaim);
    assertRepositoryWorkspaceDiskIdentity(authority, environment);
    if (
      (current?.state !== "active" && !(gatewayMove && current?.state === "draining")) ||
      current.generation !== placement.generation ||
      !isExactAttachedEnvironment(environment, current) ||
      !environment?.nodeDeviceId ||
      (Boolean(move) && !gatewayMove) ||
      workspace.kind !== "repository" ||
      workspace.repository.workspaceId !== pending.repositoryWorkspaceId
    ) {
      throw new Error(
        "Disk-authoritative workspace recovery requires its exact active repository owner",
      );
    }
  };
  await deps.workspaceOperations.run(authority.environmentId, async () => {
    assertDiskCurrent();
    // Join the existing native cleanup owner; never run input or mirror reconciliation.
    await environments.stopTunnel(placement.environmentId, placement.activeOwnerEpoch);
    assertDiskCurrent();
    await deps.prepareAcceptedWorkspacePublication?.(turnClaim);
    assertDiskCurrent();
    if (pending.workspaceAcceptedAtMs === null) {
      await placements.acceptWorkspaceResult(turnClaim, assertDiskCurrent);
    }
    if (turnClaim.owner.kind === "worker") {
      await placements.closeWorkerTurnToolState(turnClaim);
    }
    assertDiskCurrent();
    await deps.publishAcceptedWorkspace?.(turnClaim);
    assertDiskCurrent();
    await placements.completeWorkspaceResultAndReleaseTurn(turnClaim, assertDiskCurrent);
  });
}
