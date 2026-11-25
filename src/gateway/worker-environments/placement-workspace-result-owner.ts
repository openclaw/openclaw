import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import { requireRepositoryWorkspaceDiskAuthority } from "../../state/session-repository-workspaces.authority.js";
import type { WorkerPlacementMoveIntent } from "./placement-move-intent.types.js";
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

/** A Move may refresh only to export its original accepted disk, never to launch work. */
export function isRepositoryDiskGatewayMoveResult(
  placement: WorkerSessionPlacementRecord | undefined,
  pending: WorkerWorkspacePendingResult | undefined,
  move: WorkerPlacementMoveIntent | undefined,
): boolean {
  return Boolean(
    placement?.state === "draining" &&
    pending?.repositoryWorkspaceId &&
    pending.repositoryDiskAuthority?.environmentId === placement.environmentId &&
    pending.placementGeneration === placement.generation &&
    pending.claimId === pending.runId &&
    pending.claimId.startsWith("reclaim-") &&
    isCurrentWorkerWorkspacePendingResultOwner(placement, pending) &&
    move?.sessionId === placement.sessionId &&
    move.target.kind === "gateway" &&
    !move.abandonSource &&
    move.source.environmentId === placement.environmentId &&
    move.source.ownerEpoch === placement.activeOwnerEpoch &&
    move.source.generation + 1 === placement.generation,
  );
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

export function pendingResultFromRow(
  row: StateDatabase["worker_workspace_pending_results"],
): WorkerWorkspacePendingResult {
  return {
    sessionId: row.session_id,
    environmentId: row.environment_id,
    ownerEpoch: row.owner_epoch,
    placementGeneration: row.placement_generation,
    claimId: row.claim_id,
    runId: row.run_id,
    gatewayInstanceId: row.gateway_instance_id,
    recoveryRequestedAtMs: row.recovery_requested_at_ms,
    workspaceAcceptedAtMs: row.workspace_accepted_at_ms,
    stagedResultRef: row.staged_result_ref,
    ...(row.repository_workspace_id ? { repositoryWorkspaceId: row.repository_workspace_id } : {}),
    ...(row.repository_disk_authority_json !== null
      ? {
          repositoryDiskAuthority: requireRepositoryWorkspaceDiskAuthority(
            JSON.parse(row.repository_disk_authority_json),
          ),
        }
      : {}),
  };
}
