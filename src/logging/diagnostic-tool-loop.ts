/** Tool-loop diagnostic logging and trusted tool.loop event emission. */
import {
  areDiagnosticsEnabledForProcess,
  emitInternalDiagnosticEvent as emitDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import {
  diagnosticLogger as diag,
  markDiagnosticActivity as markActivity,
} from "./diagnostic-runtime.js";
import type { SessionRef } from "./diagnostic-session-state.js";

export function logToolLoopAction(
  params: SessionRef & {
    agentId?: string;
    toolName: string;
    level: "warning" | "critical";
    action: "warn" | "block";
    detector:
      | "generic_repeat"
      | "argument_churn"
      | "unknown_tool_repeat"
      | "known_poll_no_progress"
      | "global_circuit_breaker"
      | "ping_pong";
    count: number;
    message: string;
    pairedToolName?: string;
  },
) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  const payload = `tool loop: sessionId=${params.sessionId ?? "unknown"} sessionKey=${
    params.sessionKey ?? "unknown"
  } tool=${params.toolName} level=${params.level} action=${params.action} detector=${
    params.detector
  } count=${params.count}${params.pairedToolName ? ` pairedTool=${params.pairedToolName}` : ""} message="${params.message}"`;
  if (params.level === "critical") {
    diag.error(payload);
  } else {
    diag.warn(payload);
  }
  emitDiagnosticEvent({
    type: "tool.loop",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    toolName: params.toolName,
    level: params.level,
    action: params.action,
    detector: params.detector,
    count: params.count,
    message: params.message,
    pairedToolName: params.pairedToolName,
  });
  markActivity();
}
