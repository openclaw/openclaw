import {
  isCurrentPlacementTurnClaim,
  placementTurnOwner,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";

function matchesWorkspaceResultGeneration(
  placement: WorkerSessionPlacementRecord,
  generation: number,
): boolean {
  // Reclaim reserves after drain; ordinary turns reserve before it. Both exact
  // durable result generations remain recoverable without restoring live authority.
  return (
    (placement.state === "active" || placement.state === "draining") &&
    (placement.generation === generation ||
      (placement.state === "draining" && placement.generation === generation + 1))
  );
}

export function isCurrentWorkerWorkspacePendingResultOwner(
  placement: WorkerSessionPlacementRecord | undefined,
  pending: WorkerWorkspacePendingResult,
): placement is Extract<WorkerSessionPlacementRecord, { state: "active" | "draining" }> {
  if (
    (placement?.state !== "active" && placement?.state !== "draining") ||
    placement.sessionId !== pending.sessionId ||
    placement.environmentId !== pending.environmentId ||
    placement.activeOwnerEpoch !== pending.ownerEpoch
  ) {
    return false;
  }
  if (placement.turnClaim) {
    // Reclaim claims after drain; worker turns claim before it. The exact live
    // claim owns either generation shape without weakening claimless recovery.
    return isCurrentPlacementTurnClaim(placement, {
      sessionId: pending.sessionId,
      claimId: pending.claimId,
      runId: pending.runId,
      placementGeneration: pending.placementGeneration,
      owner: placementTurnOwner(placement),
    });
  }
  return matchesWorkspaceResultGeneration(placement, pending.placementGeneration);
}

export function isWorkerWorkspaceResultReconciling(
  placement: WorkerSessionPlacementRecord | undefined,
  pending: WorkerWorkspacePendingResult,
): boolean {
  const isPostTerminal =
    placement?.turnClaim?.owner === "worker" || pending.stagedResultRef !== null;
  return isPostTerminal && isCurrentWorkerWorkspacePendingResultOwner(placement, pending);
}

export function matchesWorkspaceResultClaim(
  placement: WorkerSessionPlacementRecord,
  pending: WorkerWorkspacePendingResult,
  claim: WorkerSessionTurnClaim,
): boolean {
  const recoveryOwner =
    placement.state === "active" || placement.state === "draining"
      ? placementTurnOwner(placement)
      : undefined;
  return (
    pending.sessionId === claim.sessionId &&
    pending.environmentId === placement.environmentId &&
    pending.ownerEpoch === placement.activeOwnerEpoch &&
    pending.placementGeneration === claim.placementGeneration &&
    pending.claimId === claim.claimId &&
    pending.runId === claim.runId &&
    (isCurrentPlacementTurnClaim(placement, claim) ||
      // Restart revokes local authority; only the exact durable result may finish.
      (matchesWorkspaceResultGeneration(placement, claim.placementGeneration) &&
        placement.turnClaim === null &&
        recoveryOwner?.kind === "local" &&
        claim.owner.kind === "local" &&
        claim.owner.environmentId === recoveryOwner.environmentId &&
        claim.owner.ownerEpoch === recoveryOwner.ownerEpoch))
  );
}
