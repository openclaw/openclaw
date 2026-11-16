/** Tool-loop diagnostic logging and trusted tool.loop event emission. */
import type { ToolRepeatVerdict } from "../../packages/agent-core/src/tool-repeat-guard.js";
import {
  areDiagnosticsEnabledForProcess,
  emitInternalDiagnosticEvent as emitDiagnosticEvent,
  type DiagnosticToolLoopEvent,
} from "../infra/diagnostic-events.js";
import {
  diagnosticLogger as diag,
  markDiagnosticActivity as markActivity,
} from "./diagnostic-runtime.js";
import {
  isIncognitoDiagnosticSession,
  resolveDiagnosticSessionKey,
  type SessionRef,
} from "./diagnostic-session-state.js";

function logToolLoopAction(
  params: SessionRef & Omit<DiagnosticToolLoopEvent, "type" | "seq" | "ts" | "trace">,
) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  if (!isIncognitoDiagnosticSession(params)) {
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
  }
  emitDiagnosticEvent({
    type: "tool.loop",
    sessionId: params.sessionId,
    sessionKey: resolveDiagnosticSessionKey(params),
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

/** One `tool.loop` record per repeat-guard note (warn) or stop (block). */
export function toolRepeatDiagnostics({
  sessionKey,
  sessionId,
  agentId,
}: SessionRef & { agentId?: string }): (verdict: ToolRepeatVerdict) => void {
  return ({ kind, toolName, count }) => {
    const stop = kind === "stop";
    logToolLoopAction({
      sessionKey,
      sessionId,
      ...(agentId ? { agentId } : {}),
      toolName,
      count,
      level: stop ? "critical" : "warning",
      action: stop ? "block" : "warn",
      detector: "tool_repeat",
      message: stop ? "repeat limit reached; turn ended" : "redirect note added",
    });
  };
}
