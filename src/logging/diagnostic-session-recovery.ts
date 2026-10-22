import type {
  DiagnosticSessionActiveWorkKind,
  DiagnosticSessionState,
} from "../infra/diagnostic-events.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";

type DiagnosticSessionRecoverySkipReason =
  | "active_embedded_run"
  | "model_attempt_recovery"
  | "active_reply_work"
  | "human_input_wait"
  | "runtime_owned_wait"
  | "deferred_maintenance_wait"
  | "terminal_outcome_committed"
  | "global_lane_wait"
  | "active_lane_task"
  | "already_in_flight"
  | "missing_session_ref"
  | "stale_session_state";

export type StuckSessionRecoveryRequest = {
  /** Exact captured controller owner; diagnostic IDs and map absence grant no authority. */
  operation?: ReplyOperation;
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  ageMs: number;
  queueDepth?: number;
  /** Recorded controller decision for SDK recovery callbacks, never independent authority. */
  allowActiveAbort?: boolean;
  /** Legacy diagnostic threshold metadata retained by the logging-core SDK callback contract. */
  repeatedRequestNoProgressAbortMs?: number;
  expectedState?: DiagnosticSessionState;
  stateGeneration?: number;
  /**
   * Legacy observation threshold retained for SDK callback compatibility.
   * The captured controller alone decides whether its work can be recovered.
   */
  staleActiveProgressAbortMs?: number;
  /**
   * Resolved compaction timeout metadata retained for SDK callbacks.
   * It never grants ownerless recovery or changes the controller deadline.
   */
  compactionSafetyTimeoutMs?: number;
};

type DiagnosticSessionRecoveryBaseOutcome = {
  sessionId?: string;
  sessionKey?: string;
  activeSessionId?: string;
  lane?: string;
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
};

export type StuckSessionRecoveryOutcome =
  | (DiagnosticSessionRecoveryBaseOutcome & {
      status: "aborted";
      action: "abort_embedded_run";
      aborted: boolean;
      drained: boolean;
      forceCleared: boolean;
      released: number;
      queuedCount?: number;
    })
  | (DiagnosticSessionRecoveryBaseOutcome & {
      status: "released";
      action: "release_lane";
      reason?: "no_active_work" | "stale_lane_task";
      released: number;
      queuedCount?: number;
    })
  | (DiagnosticSessionRecoveryBaseOutcome & {
      status: "skipped";
      action: "observe_only" | "keep_lane";
      reason: DiagnosticSessionRecoverySkipReason;
      activeCount?: number;
      queuedCount?: number;
    })
  | (DiagnosticSessionRecoveryBaseOutcome & {
      status: "failed";
      action: "none";
      reason: "exception";
      error: string;
    })
  | (DiagnosticSessionRecoveryBaseOutcome & {
      status: "failed";
      action: "fail_worker_turn";
      reason: "terminal_worker";
      error: string;
    });

export function formatRecoveryOutcome(outcome: StuckSessionRecoveryOutcome): string {
  const fields = [
    `status=${outcome.status}`,
    `action=${outcome.action}`,
    `sessionId=${outcome.sessionId ?? outcome.activeSessionId ?? "unknown"}`,
    `sessionKey=${outcome.sessionKey ?? "unknown"}`,
  ];
  if (outcome.activeSessionId) {
    fields.push(`activeSessionId=${outcome.activeSessionId}`);
  }
  if (outcome.activeWorkKind) {
    fields.push(`activeWorkKind=${outcome.activeWorkKind}`);
  }
  if (outcome.lane) {
    fields.push(`lane=${outcome.lane}`);
  }
  if ("reason" in outcome) {
    fields.push(`reason=${outcome.reason}`);
  }
  if ("aborted" in outcome) {
    fields.push(
      `aborted=${outcome.aborted}`,
      `drained=${outcome.drained}`,
      `forceCleared=${outcome.forceCleared}`,
    );
  }
  if ("released" in outcome) {
    fields.push(`released=${outcome.released}`);
  }
  if (
    (outcome.status === "aborted" || outcome.status === "released") &&
    outcome.queuedCount !== undefined
  ) {
    fields.push(`queuedCount=${outcome.queuedCount}`);
  }
  if ("activeCount" in outcome && outcome.activeCount !== undefined) {
    fields.push(`laneActive=${outcome.activeCount}`);
  }
  if (outcome.status === "skipped" && outcome.queuedCount !== undefined) {
    fields.push(`laneQueued=${outcome.queuedCount}`);
  }
  if ("error" in outcome) {
    fields.push(`error=${outcome.error}`);
  }
  return fields.join(" ");
}
