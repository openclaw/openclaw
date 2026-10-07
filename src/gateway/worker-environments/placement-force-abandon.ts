import {
  FORCED_WORKER_ABANDONMENT_ERROR,
  placementTurnOwner,
  type WorkerSessionPlacementIdentity,
  type WorkerSessionPlacementRecord,
} from "./placement-record.js";
import type { PlacementRecoveryDeps } from "./placement-recovery-contract.js";
import { isCurrentWorkerWorkspacePendingResultOwner } from "./placement-workspace-result.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile.js";
import {
  deleteStagedWorkerWorkspaceResult,
  hasWorkerWorkspaceResultRef,
  preparedWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

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

export async function forceAbandonWorkerEnvironment(
  params: Pick<PlacementRecoveryDeps, "placements" | "resolveWorkspace"> & {
    environmentId: string;
    onCleanupError?: (error: unknown) => void;
  },
): Promise<void> {
  const { environmentId, placements } = params;
  const recoveryError = FORCED_WORKER_ABANDONMENT_ERROR;
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
    const placement = await placements.getAsync(owner.sessionId);
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
      const placement = await placements.getAsync(pending.sessionId);
      if (isCurrentWorkerWorkspacePendingResultOwner(placement, pending)) {
        const finalRef = pending.stagedResultRef ?? workerWorkspaceResultRef(pending.claimId);
        stagedResultCleanups.push({
          placement,
          refs: [finalRef, preparedWorkerWorkspaceResultRef(finalRef)],
          repositoryWorkspaceId: pending.repositoryWorkspaceId,
        });
        const claim = placement.turnClaim;
        if (claim && claim.claimId === pending.claimId && claim.runId === pending.runId) {
          await placements.closeWorkerTurnToolState({
            sessionId: placement.sessionId,
            claimId: claim.claimId,
            runId: claim.runId,
            placementGeneration: claim.generation,
            owner: placementTurnOwner(placement),
          });
        }
        await placements.failWorkspaceResultAndReleaseTurn(pending, recoveryError);
      } else {
        await placements.abandonWorkspaceResult(pending);
      }
    }
  }
  for (const placement of await placements.listForReconcileAsync()) {
    if (placement.environmentId !== environmentId) {
      continue;
    }
    let current: WorkerSessionPlacementRecord = placement;
    if (current?.state === "active") {
      current = await placements.startDrain({
        sessionId: current.sessionId,
        environmentId: current.environmentId,
        ownerEpoch: current.activeOwnerEpoch,
        expectedGeneration: current.generation,
      });
    }
    if (current?.state === "draining") {
      if (current.turnClaim) {
        await placements.closeWorkerTurnToolState({
          sessionId: current.sessionId,
          claimId: current.turnClaim.claimId,
          runId: current.turnClaim.runId,
          placementGeneration: current.turnClaim.generation,
          owner: placementTurnOwner(current),
        });
      }
      current = await placements.startReconcile({
        sessionId: current.sessionId,
        environmentId: current.environmentId,
        ownerEpoch: current.activeOwnerEpoch,
        expectedGeneration: current.generation,
        forceLocalClaim: true,
      });
    }
    if (current && (current.state !== "failed" || current.recoveryError !== recoveryError)) {
      await placements.fail({
        sessionId: current.sessionId,
        expectedGeneration: current.generation,
        recoveryError,
      });
    }
  }

  // The durable fence is now closed. Filesystem rollback and ref cleanup are
  // useful hygiene, but a changed or missing workspace must not revive it.
  for (const cleanup of journalCleanups) {
    if (cleanup.journal.appliedManifestRef) {
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
      if (workspace.kind === "repository") {
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
}
