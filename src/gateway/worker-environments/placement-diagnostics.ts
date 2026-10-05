import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("gateway/worker-placement");
export const MAX_PREPARED_CANDIDATE_OBSERVATIONS = 8;

type PlacementStage =
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

export function recordWorkerPlacementStage(
  sessionId: string,
  stage: PlacementStage,
  facts: {
    generation?: number;
    environmentId?: string | null;
    ownerEpoch?: number;
    preparationKey?: string;
    prepared?: boolean;
    candidateCount?: number;
    rejectedCount?: number;
    elapsedMs?: number;
    certainty?: "unknown" | "confirmed";
  } = {},
) {
  try {
    log.info("worker placement stage", {
      sessionId,
      stage,
      atMs: Date.now(),
      generation: facts.generation,
      environmentId: facts.environmentId,
      ownerEpoch: facts.ownerEpoch,
      preparationKey: facts.preparationKey,
      prepared: facts.prepared,
      candidateCount: facts.candidateCount,
      rejectedCount: facts.rejectedCount,
      elapsedMs: facts.elapsedMs,
      certainty: facts.certainty,
    });
  } catch {
    // A diagnostic sink cannot decide placement admission or settlement.
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
