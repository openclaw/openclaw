// Diagnostic session attention helpers summarize active work for session diagnostics.
import type { DiagnosticSessionActiveWorkKind } from "../infra/diagnostic-events.js";
import type { DiagnosticSessionActivitySnapshot } from "./diagnostic-run-activity.js";

export type SessionAttentionClassification =
  | {
      eventType: "session.long_running";
      reason: string;
      classification: "long_running";
      activeWorkKind?: DiagnosticSessionActiveWorkKind;
      recoveryEligible: false;
    }
  | {
      eventType: "session.stalled";
      reason: string;
      classification: "blocked_tool_call" | "stalled_agent_run" | "terminal_progress_orphan";
      activeWorkKind?: DiagnosticSessionActiveWorkKind;
      recoveryEligible: false;
    }
  | {
      eventType: "session.stuck";
      reason: string;
      classification: "stale_session_state";
      activeWorkKind?: undefined;
      recoveryEligible: true;
    };

export function classifySessionAttention(params: {
  state?: "idle" | "processing" | "waiting";
  queueDepth: number;
  activity: DiagnosticSessionActivitySnapshot;
  staleMs: number;
}): SessionAttentionClassification {
  if (params.activity.activeWorkKind) {
    // Idle session with queued work and stale orphaned activity (no active
    // embedded owner) should be classified as recoverable stuck state, not as
    // stalled active work. This prevents orphaned model_call or tool_call
    // activity from blocking the queue indefinitely.
    if (
      params.state === "idle" &&
      params.queueDepth > 0 &&
      params.activity.hasActiveEmbeddedRun !== true &&
      (params.activity.lastProgressAgeMs ?? 0) > params.staleMs
    ) {
      return {
        eventType: "session.stuck",
        reason: "queued_work_without_active_run",
        classification: "stale_session_state",
        recoveryEligible: true,
      };
    }
    if (
      params.activity.activeWorkKind === "tool_call" &&
      (params.activity.activeToolAgeMs ?? 0) > params.staleMs &&
      (params.activity.lastProgressAgeMs ?? 0) > params.staleMs
    ) {
      return {
        eventType: "session.stalled",
        reason: "blocked_tool_call",
        classification: "blocked_tool_call",
        activeWorkKind: params.activity.activeWorkKind,
        recoveryEligible: false,
      };
    }
    if (
      params.queueDepth > 0 &&
      params.activity.activeWorkKind === "embedded_run" &&
      isTerminalDiagnosticProgressReason(params.activity.lastProgressReason)
    ) {
      return {
        eventType: "session.stalled",
        reason: "queued_behind_terminal_active_work",
        classification: "stalled_agent_run",
        activeWorkKind: params.activity.activeWorkKind,
        recoveryEligible: false,
      };
    }
    if ((params.activity.lastProgressAgeMs ?? 0) > params.staleMs) {
      // When the last codex app-server progress event was itself terminal-looking
      // (`rawResponseItem/completed`, `response.completed`, `output_item.done`, …)
      // and no further progress arrives, surface a distinct `terminal_progress_orphan`
      // classification so operators can tell apart "no progress, may still be working"
      // from "last progress was terminal-looking, lifecycle never closed". This is
      // observability-only — `recoveryEligible: false` matches the existing
      // `stalled_agent_run` path, so no recovery timing changes. The contract for
      // whether item-level terminal events authorize earlier abort is still owned by
      // the maintainers (https://github.com/openclaw/openclaw/issues/85532).
      if (
        params.activity.activeWorkKind === "embedded_run" &&
        isTerminalDiagnosticProgressReason(params.activity.lastProgressReason)
      ) {
        return {
          eventType: "session.stalled",
          reason: "terminal_progress_orphan",
          classification: "terminal_progress_orphan",
          activeWorkKind: params.activity.activeWorkKind,
          recoveryEligible: false,
        };
      }
      return {
        eventType: "session.stalled",
        reason: "active_work_without_progress",
        classification: "stalled_agent_run",
        activeWorkKind: params.activity.activeWorkKind,
        recoveryEligible: false,
      };
    }
    return {
      eventType: "session.long_running",
      reason: params.queueDepth > 0 ? "queued_behind_active_work" : "active_work",
      classification: "long_running",
      activeWorkKind: params.activity.activeWorkKind,
      recoveryEligible: false,
    };
  }

  return {
    eventType: "session.stuck",
    reason: params.queueDepth > 0 ? "queued_work_without_active_run" : "stale_session_state",
    classification: "stale_session_state",
    recoveryEligible: true,
  };
}

export function isTerminalDiagnosticProgressReason(reason: string | undefined): boolean {
  if (!reason) {
    return false;
  }
  return (
    reason === "run:completed" ||
    reason === "embedded_run:ended" ||
    reason.includes("response.completed") ||
    reason.includes("rawResponseItem/completed") ||
    reason.includes("raw_response_item.completed") ||
    reason.includes("output_item.done")
  );
}
