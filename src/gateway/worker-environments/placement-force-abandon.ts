import { DEVICE_FOLDER_MANIFEST_REF } from "../../worker/device-folder.js";
import {
  FORCED_WORKER_ABANDONMENT_ERROR,
  projectPlacementTurnClaim,
  type WorkerSessionPlacementIdentity,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import type { PlacementRecoveryDeps } from "./placement-recovery-contract.js";
import { isCurrentWorkerWorkspacePendingResultOwner } from "./placement-workspace-result-owner.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile.js";
import {
  deleteStagedWorkerWorkspaceResult,
  hasWorkerWorkspaceResultRef,
  preparedWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

// Preserve the persisted producer identity, including remote-exec's local claim owner.
function capturePlacementTurnClaim(
  placement: Pick<WorkerSessionPlacementRecord, "sessionId" | "turnClaim"> & {
    environmentId: string;
    activeOwnerEpoch: number;
  },
): WorkerSessionTurnClaim | undefined {
  const claim = placement.turnClaim;
  if (!claim) {
    return undefined;
  }
  return {
    sessionId: placement.sessionId,
    claimId: claim.claimId,
    runId: claim.runId,
    placementGeneration: claim.generation,
    owner:
      claim.owner === "worker"
        ? {
            kind: "worker",
            environmentId: placement.environmentId,
            ownerEpoch: claim.ownerEpoch,
          }
        : {
            kind: "local",
            environmentId: placement.environmentId,
            ownerEpoch: placement.activeOwnerEpoch,
          },
  };
}

// A claim successor can reuse the environment and placement generation without owning this Stop.
function isCapturedPlacementCurrent(
  captured: WorkerSessionPlacementRecord | undefined,
  current: WorkerSessionPlacementRecord | undefined,
): boolean {
  // Stale artifacts without a working placement still need their existing cleanup path.
  if (!captured || !current) {
    return !current || current.state === "local" || current.state === "reclaimed";
  }
  return (
    captured.environmentId === current.environmentId &&
    captured.activeOwnerEpoch === current.activeOwnerEpoch &&
    captured.generation === current.generation &&
    captured.executionMode === current.executionMode &&
    // A completed captured turn leaves this placement eligible for abandonment.
    (!current.turnClaim ||
      (captured.turnClaim?.claimId === current.turnClaim.claimId &&
        captured.turnClaim?.runId === current.turnClaim.runId &&
        captured.turnClaim?.generation === current.turnClaim.generation &&
        captured.turnClaim?.owner === current.turnClaim.owner &&
        captured.turnClaim?.ownerEpoch === current.turnClaim.ownerEpoch))
  );
}

export function reportWorkerAbandonmentCleanupError(
  onCleanupError: ((error: unknown) => void) | undefined,
  error: unknown,
): void {
  try {
    onCleanupError?.(error);
  } catch {
    // Cleanup reporting cannot overturn a committed forced abandonment.
  }
}

/** Fence nested tool admission, drain entered work, then abandon the environment's results. */
export async function forceAbandonWorkerEnvironment(
  params: Pick<PlacementRecoveryDeps, "placements" | "resolveWorkspace"> & {
    environmentId: string;
    onCleanupError?: (error: unknown) => void;
  },
): Promise<ReadonlyMap<string, WorkerSessionPlacementRecord>> {
  const { environmentId, placements } = params;
  const failedPlacements = new Map<string, WorkerSessionPlacementRecord>();
  const reconcilePlacements = await placements.listForReconcileAsync();
  // Refuse before fencing or mutating any owner: there is no Gateway copy to recover.
  for (const placement of reconcilePlacements) {
    if (
      placement.environmentId === environmentId &&
      placement.workspaceBaseManifestRef === DEVICE_FOLDER_MANIFEST_REF
    ) {
      throw new Error(
        "Device folders cannot be abandoned onto the Gateway; reconnect the device and stop its session instead.",
      );
    }
  }
  const recoveryError = FORCED_WORKER_ABANDONMENT_ERROR;
  const capturedPlacements = new Map(
    reconcilePlacements.map((placement) => [placement.sessionId, placement]),
  );
  const toolDrains: Promise<void>[] = [];
  // Invoke every captured close before yielding: journal preparation cannot admit more tools.
  for (const placement of reconcilePlacements) {
    if (placement.environmentId === environmentId && placement.activeOwnerEpoch !== null) {
      const claim = capturePlacementTurnClaim({
        ...placement,
        environmentId,
        activeOwnerEpoch: placement.activeOwnerEpoch,
      });
      if (claim) {
        toolDrains.push(placements.closeWorkerTurnToolState(claim));
      }
    }
  }
  await Promise.all(toolDrains);
  const journalOwners = (await params.placements.listWorkspaceReconciliationOwners()).filter(
    (owner) => owner.environmentId === environmentId,
  );
  const journalCleanups: Array<{
    owner: (typeof journalOwners)[number];
    placement: WorkerSessionPlacementIdentity;
    journal: NonNullable<Awaited<ReturnType<typeof placements.loadWorkspaceReconciliation>>>;
  }> = [];
  const retainedJournalSessions = new Set<string>();
  for (const owner of journalOwners) {
    const { placement } = await placements.getWithMoveAsync(owner.sessionId);
    if (!isCapturedPlacementCurrent(capturedPlacements.get(owner.sessionId), placement)) {
      retainedJournalSessions.add(owner.sessionId);
      continue;
    }
    const isCurrentOwner =
      (placement?.state === "active" || placement?.state === "draining") &&
      placement.generation === owner.placementGeneration;
    const isForceFailedOwner =
      placement?.state === "failed" &&
      placement.recoveryError.startsWith(recoveryError) &&
      placement.generation > owner.placementGeneration;
    if (
      placement &&
      (isCurrentOwner || isForceFailedOwner) &&
      placement.environmentId === owner.environmentId &&
      placement.activeOwnerEpoch === owner.ownerEpoch
    ) {
      try {
        const journal = await placements.loadWorkspaceReconciliation(
          owner,
          isForceFailedOwner ? { allowFailedOwner: true } : undefined,
        );
        if (journal) {
          journalCleanups.push({ owner, placement, journal });
        }
      } catch (error) {
        reportWorkerAbandonmentCleanupError(params.onCleanupError, error);
        retainedJournalSessions.add(owner.sessionId);
      }
    }
  }
  const stagedResultCleanups: Array<{
    placement: WorkerSessionPlacementIdentity;
    refs: string[];
    repositoryWorkspaceId?: string;
  }> = [];
  for (const pending of await placements.listPendingWorkspaceResultsAsync()) {
    if (pending.environmentId === environmentId) {
      const { placement } = await placements.getWithMoveAsync(pending.sessionId);
      if (!isCapturedPlacementCurrent(capturedPlacements.get(pending.sessionId), placement)) {
        retainedJournalSessions.add(pending.sessionId);
        continue;
      }
      if (isCurrentWorkerWorkspacePendingResultOwner(placement, pending)) {
        const finalRef = pending.stagedResultRef ?? workerWorkspaceResultRef(pending.claimId);
        stagedResultCleanups.push({
          placement,
          refs: [finalRef, preparedWorkerWorkspaceResultRef(finalRef)],
          repositoryWorkspaceId: pending.repositoryWorkspaceId,
        });
        const claim = projectPlacementTurnClaim(placement);
        if (claim && claim.claimId === pending.claimId && claim.runId === pending.runId) {
          await placements.closeWorkerTurnToolState(claim);
        }
        capturedPlacements.set(
          pending.sessionId,
          await placements.failWorkspaceResultAndReleaseTurn(pending, recoveryError),
        );
      } else {
        await placements.abandonWorkspaceResult(pending);
      }
    }
  }
  for (const placement of reconcilePlacements) {
    if (placement.environmentId !== environmentId) {
      continue;
    }
    let { placement: current } = await placements.getWithMoveAsync(placement.sessionId);
    if (
      !current ||
      !isCapturedPlacementCurrent(capturedPlacements.get(placement.sessionId), current)
    ) {
      retainedJournalSessions.add(placement.sessionId);
      continue;
    }
    // Carry the original claim or claimlessness through both native transitions.
    const claim =
      current.state === "active" || current.state === "draining"
        ? capturePlacementTurnClaim(current)
        : undefined;
    if (current.state === "active") {
      current = await placements.startDrain({
        sessionId: current.sessionId,
        environmentId: current.environmentId,
        ownerEpoch: current.activeOwnerEpoch,
        expectedGeneration: current.generation,
        ...(claim ? { expectedTurnClaim: claim } : { requireUnclaimed: true }),
      });
    }
    if (current.state === "draining") {
      // Worker tools can be reauthorized during preparation; local claims cannot admit them.
      // The native transaction validates this same capture after entered work drains.
      if (claim?.owner.kind === "worker") {
        await placements.closeWorkerTurnToolState(claim);
      }
      current = await placements.startReconcile({
        sessionId: current.sessionId,
        environmentId: current.environmentId,
        ownerEpoch: current.activeOwnerEpoch,
        expectedGeneration: current.generation,
        forceLocalClaim: true,
        ...(claim ? { expectedTurnClaim: claim } : { requireUnclaimed: true }),
      });
    }
    if (current.state !== "failed" || current.recoveryError !== recoveryError) {
      current = await placements.fail({
        sessionId: current.sessionId,
        expectedGeneration: current.generation,
        recoveryError,
      });
    }
    failedPlacements.set(current.sessionId, current);
  }

  // The durable fence is now closed. Filesystem rollback and ref cleanup are
  // useful hygiene, but a changed or missing workspace must not revive it.
  for (const cleanup of journalCleanups) {
    if (
      retainedJournalSessions.has(cleanup.owner.sessionId) ||
      cleanup.journal.appliedManifestRef
    ) {
      continue;
    }
    try {
      const workspace = await params.resolveWorkspace(cleanup.placement);
      if (workspace.kind !== "local") {
        throw new Error("Repository workspace cannot own a local rollback journal");
      }
      await recoverWorkerWorkspaceReconciliation({
        root: workspace.path,
        journal: cleanup.journal,
      });
    } catch (error) {
      reportWorkerAbandonmentCleanupError(params.onCleanupError, error);
      retainedJournalSessions.add(cleanup.owner.sessionId);
    }
  }
  // Placement failure is durable before journal removal. A crash during the
  // best-effort rollback therefore leaves a fenced placement and retriable journal.
  for (const owner of journalOwners) {
    if (retainedJournalSessions.has(owner.sessionId)) {
      continue;
    }
    await placements.abortWorkspaceReconciliation(owner, { force: true });
  }
  for (const cleanup of stagedResultCleanups) {
    try {
      // Repository refs remain the durable session data even when the operator
      // abandons a worker; only the repository workspace deletion owns them.
      if (cleanup.repositoryWorkspaceId) {
        continue;
      }
      const workspace = await params.resolveWorkspace(cleanup.placement);
      if (workspace.kind !== "local") {
        continue;
      }
      const root = workspace.path;
      for (const stagedResultRef of cleanup.refs) {
        if (await hasWorkerWorkspaceResultRef({ root, stagedResultRef })) {
          await deleteStagedWorkerWorkspaceResult({ root, stagedResultRef });
        }
      }
    } catch (error) {
      reportWorkerAbandonmentCleanupError(params.onCleanupError, error);
    }
  }
  return failedPlacements;
}
