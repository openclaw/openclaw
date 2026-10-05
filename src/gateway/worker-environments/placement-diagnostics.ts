import {
  collectNestedErrorCandidates,
  extractErrorCode,
  readErrorName,
} from "@openclaw/normalization-core/error-coercion";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("gateway/worker-placement");
export const MAX_PREPARED_CANDIDATE_OBSERVATIONS = 8;

type PlacementAwaitPhase =
  | "turn_placement_read"
  | "turn_workspace_resolve"
  | "turn_workspace_recovery"
  | "turn_tunnel"
  | "turn_attachments"
  | "turn_skill_resources"
  | "turn_computer"
  | "repository_ref_preparation"
  | "retained_worker_recovery"
  | "prepared_repository_revalidation"
  | "cold_repository_revalidation"
  | "post_sync_repository_revalidation"
  | "workspace_preparation"
  | "workspace_sync"
  | "repository_checkpoint_source"
  | "repository_identity"
  | "repository_checkpoint_load"
  | "repository_sync"
  | "repository_prepare"
  | "repository_transfer_bind"
  | "repository_checkpoint_restore"
  | "repository_validation"
  | "node_workspace_rpc"
  | "activation"
  | "barrier"
  | "lifecycle_context"
  | "lifecycle_fence"
  | "session_target"
  | "cancel_session_work"
  | "cancel_and_drain"
  | "pending_dispatch_settlement"
  | "work_admission_drain"
  | "turn_claim_release"
  | "session_writer_drain"
  | "placement_drain"
  | "workspace_owner"
  | "result_claim"
  | "prepared_recovery"
  | "journal_load"
  | "journal_recover"
  | "journal_abort"
  | "tunnel"
  | "workspace_lock"
  | "quiesce"
  | "snapshot_reconcile"
  | "final_workspace_fence"
  | "checkpoint_accept"
  | "pending_result_read"
  | "prior_conflict"
  | "conflict_finalize"
  | "result_finalize"
  | "gateway_materialize"
  | "provider_destroy"
  | "placement_teardown"
  | "tunnel_detach"
  | "quiescence_release"
  | "result_cancel"
  | "turn_tool_close"
  | "empty_ref_probe"
  | "result_recovery_handoff";

type PlacementStage =
  | "turn_runner_invoked"
  | `${"reclaim_" | "dispatch_" | ""}${PlacementAwaitPhase}_${"started" | "completed" | "failed"}`
  | "node_tunnel_retired"
  | "repository_preparation_interrupted"
  | "dispatch_received"
  | "dispatch_joined"
  | "dispatch_admitted"
  | "local_barrier_started"
  | "local_barrier_completed"
  | "workspace_resolve_started"
  | "workspace_resolve_completed"
  | "intent_prepare_started"
  | "intent_prepare_completed"
  | "prepared_selection_started"
  | "prepared_selection_completed"
  | "prepared_claimed"
  | "environment_ready"
  | "session_attach_started"
  | "session_attached"
  | "tunnel_started"
  | "tunnel_ready"
  | "workspace_sync_started"
  | "workspace_sync_completed"
  | "activation_started"
  | "active"
  | "dispatch_failed"
  | "recovery_disposal_staged"
  | "recovery_disposal_pending"
  | "recovery_disposal_settled"
  | "recovery_checkpoint_accepted";

export type PreparedCandidateRejectionCode =
  | "target_disabled"
  | "pool_disabled"
  | "not_ready"
  | "provider_mismatch"
  | "preparation_missing"
  | "preparation_mismatch"
  | "consumed"
  | "expired"
  | "destroy_requested"
  | "not_dedicated"
  | "node_missing"
  | "lease_missing"
  | "repository_base_mismatch"
  | "bootstrap_missing"
  | "launch_protocol_mismatch"
  | "build_mismatch"
  | "node_admission_unavailable"
  | "node_authority_changed"
  | "candidate_changed"
  | "claim_conflict";

export type PreparedCandidateRejectionObserver = (
  environmentId: string,
  code: PreparedCandidateRejectionCode,
) => void;

// Only protocol/errno constants cross this metadata boundary; provider payloads stay private.
const SAFE_FAILURE_CODES = [
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOSPC",
  "EIO",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ABORT_ERR",
  "INVALID_REQUEST",
  "UNAVAILABLE",
  "WORKSPACE_TRANSFER_FAILED",
] as const;

function readPlacementFailureCode(error: unknown) {
  try {
    for (const candidate of collectNestedErrorCandidates(error)) {
      const code = extractErrorCode(candidate);
      const recognized = SAFE_FAILURE_CODES.find((safe) => safe === code);
      if (recognized) {
        return recognized;
      }
      if (readErrorName(candidate) === "AbortError") {
        return "ABORT_ERR";
      }
    }
  } catch {
    // Hostile or malformed error getters cannot replace the operation's outcome.
  }
  return undefined;
}

export function recordWorkerPlacementStage(
  sessionId: string,
  stage: PlacementStage,
  facts: {
    generation?: number;
    environmentId?: string | null;
    ownerEpoch?: number;
    claimId?: string;
    runId?: string;
    diagnosticCode?: "operation_failed";
    error?: unknown;
    preparationKey?: string;
    prepared?: boolean;
    candidateCount?: number;
    rejectedCount?: number;
    elapsedMs?: number;
    certainty?: "unknown" | "confirmed";
    cancellationOwner?: "session_lifecycle";
    preparationPhase?:
      | "dispatch_admission"
      | "dispatch"
      | "background"
      | "intent"
      | "source_validation"
      | "workspace_sync"
      | "post_sync_validation"
      | "ready_publication";
    preparationSignalAborted?: boolean;
    operatorSignalAborted?: boolean;
    rpcPhase?: "node_lookup" | "invoke" | "response";
    failureKind?: "exception" | "response";
    cancellationSource?: "tunnel_owner" | "command" | "deadline" | "none";
    dispatchStarted?: boolean;
    tunnelRetirementReason?:
      | "owner_stop"
      | "provider-destroying"
      | "provider-destroyed"
      | "workspace_drain_failed";
  } = {},
) {
  try {
    log.info("worker placement stage", {
      sessionId,
      stage,
      atMs: Date.now(),
      monotonicAtMs: performance.now(),
      generation: facts.generation,
      environmentId: facts.environmentId,
      ownerEpoch: facts.ownerEpoch,
      claimId: facts.claimId,
      runId: facts.runId,
      diagnosticCode: facts.diagnosticCode,
      innerDiagnosticCode: readPlacementFailureCode(facts.error),
      preparationKey: facts.preparationKey,
      prepared: facts.prepared,
      candidateCount: facts.candidateCount,
      rejectedCount: facts.rejectedCount,
      elapsedMs: facts.elapsedMs,
      certainty: facts.certainty,
      cancellationOwner: facts.cancellationOwner,
      preparationPhase: facts.preparationPhase,
      preparationSignalAborted: facts.preparationSignalAborted,
      operatorSignalAborted: facts.operatorSignalAborted,
      rpcPhase: facts.rpcPhase,
      failureKind: facts.failureKind,
      cancellationSource: facts.cancellationSource,
      dispatchStarted: facts.dispatchStarted,
      tunnelRetirementReason: facts.tunnelRetirementReason,
    });
  } catch {
    // A diagnostic sink cannot decide placement admission or settlement.
  }
}

/** Report the exact awaited phase without deciding its outcome or exposing its error payload. */
export async function recordWorkerPlacementAwait<T>(
  sessionId: string,
  phase: PlacementAwaitPhase,
  operation: () => T | Promise<T>,
  facts: NonNullable<Parameters<typeof recordWorkerPlacementStage>[2]> = {},
  scope: "reclaim" | "dispatch" | "placement" = "reclaim",
): Promise<T> {
  const startedAt = performance.now();
  const prefix = scope === "placement" ? "" : scope === "dispatch" ? "dispatch_" : "reclaim_";
  recordWorkerPlacementStage(sessionId, `${prefix}${phase}_started`, facts);
  try {
    const result = await operation();
    recordWorkerPlacementStage(sessionId, `${prefix}${phase}_completed`, {
      ...facts,
      elapsedMs: performance.now() - startedAt,
    });
    return result;
  } catch (error) {
    recordWorkerPlacementStage(sessionId, `${prefix}${phase}_failed`, {
      ...facts,
      elapsedMs: performance.now() - startedAt,
      diagnosticCode: "operation_failed",
      error,
    });
    throw error;
  }
}

export function recordPreparedCandidateRejection(
  sessionId: string,
  environmentId: string,
  code: PreparedCandidateRejectionCode,
) {
  try {
    log.info("worker prepared candidate rejected", {
      sessionId,
      environmentId,
      code,
      atMs: Date.now(),
    });
  } catch {
    // A diagnostic sink cannot change which candidate is selected.
  }
}
