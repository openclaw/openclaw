import {
  findSessionControllerEntries,
  resolveReplyRunForCurrentSessionId,
} from "../sessions/session-controller.state.js";
import type { SessionWatchdogSnapshot } from "../sessions/session-controller.watchdog-state.js";
import type { DiagnosticSessionActivitySnapshot } from "./diagnostic-run-activity-snapshot.js";

/** Logical aliases may span physical stores; diagnostic IDs never select an ambiguous owner. */
export function captureDiagnosticSessionOperation(params: {
  sessionId?: string;
  sessionKey?: string;
}) {
  const session = params.sessionId
    ? resolveReplyRunForCurrentSessionId(params.sessionId)
    : undefined;
  const keyed = params.sessionKey
    ? findSessionControllerEntries(params.sessionKey).flatMap((entry) =>
        entry.active ? [entry.active] : [],
      )
    : undefined;
  return params.sessionId
    ? session?.kind === "one" &&
      (!keyed || keyed.some((operation) => operation === session.operation))
      ? session.operation
      : undefined
    : keyed?.length === 1
      ? keyed[0]
      : undefined;
}

/** Diagnostic events may be disabled, delayed or dropped; progress comes from the owner. */
export function projectControllerDiagnosticActivity(
  state: SessionWatchdogSnapshot,
  now: number,
): DiagnosticSessionActivitySnapshot {
  if (!state.current) {
    return {};
  }
  const oldestTool = state.tools.reduce<SessionWatchdogSnapshot["tools"][number] | undefined>(
    (oldest, tool) => (!oldest || tool.startedAtMs < oldest.startedAtMs ? tool : oldest),
    undefined,
  );
  const deadline = (kind: "backend" | "retry") => {
    const values = state.waits
      .filter((wait) => wait.kind === kind && wait.deadlineAtMs !== undefined)
      .map((wait) => wait.deadlineAtMs!);
    return values.length ? Math.max(...values) : undefined;
  };
  const toolDeadline = state.tools.length
    ? Math.max(...state.tools.map((tool) => tool.deadlineAtMs))
    : undefined;
  const explicitToolDeadlines = state.tools
    .filter((tool) => tool.explicitDeadlineAtMs !== undefined)
    .map((tool) => tool.deadlineAtMs);
  const requestTimeouts = (state.requests ?? [])
    .map((request) => request.requestTimeoutMs)
    .filter((timeout): timeout is number => timeout !== undefined);
  const requestDeadlines = (state.requests ?? [])
    .map((request) => request.deadlineAtMs)
    .filter((requestDeadline): requestDeadline is number => requestDeadline !== undefined);
  return {
    hasActiveEmbeddedRun: state.hasActiveAttempt || undefined,
    activeWorkKind: oldestTool
      ? "tool_call"
      : state.requests?.length
        ? "model_call"
        : state.hasActiveAttempt
          ? "embedded_run"
          : undefined,
    activeModelCallRequestTimeoutMs: requestTimeouts.length
      ? Math.max(...requestTimeouts)
      : undefined,
    activeModelCallRecoveryDeadlineAtMs: requestDeadlines.length
      ? Math.max(...requestDeadlines)
      : undefined,
    lastProgressAgeMs: Math.max(0, now - state.semanticProgressAtMs),
    lastProgressReason: state.lastProgressReason,
    activeToolName: oldestTool?.toolName,
    activeToolCallId: oldestTool?.toolCallId,
    activeToolAgeMs: oldestTool ? Math.max(0, now - oldestTool.startedAtMs) : undefined,
    activeToolDeadlineAtMs: explicitToolDeadlines.length
      ? Math.max(...explicitToolDeadlines)
      : undefined,
    activeToolRecoveryDeadlineAtMs: toolDeadline,
    activeBackendLivenessDeadlineAtMs: deadline("backend"),
    activeRetryWaitDeadlineAtMs: deadline("retry"),
  };
}
