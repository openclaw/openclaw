import {
  areDiagnosticsEnabledForProcess,
  emitInternalDiagnosticEvent as emitDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticSessionState,
  touchDiagnosticSessionState,
  type SessionRef,
} from "./diagnostic-session-state.js";
import { createSubsystemLogger } from "./subsystem.js";

export const diagnosticLogger = createSubsystemLogger("diagnostic");
let lastActivityAt = 0;

export function markDiagnosticActivity(): void {
  lastActivityAt = Date.now();
}

export function getLastDiagnosticActivityAt(): number {
  return lastActivityAt;
}

export function resetDiagnosticActivityForTest(): void {
  lastActivityAt = 0;
}

type DiagnosticMessageQueueParams = SessionRef & {
  channel?: string;
  source: string;
};

/** Records queue activity while letting internal run owners distinguish steering from backlog. */
export function logMessageQueuedWithBacklogPolicy(
  params: DiagnosticMessageQueueParams,
  countsTowardBacklog: boolean,
): void {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  const state = getDiagnosticSessionState(params);
  if (countsTowardBacklog) {
    state.queueDepth += 1;
  }
  touchDiagnosticSessionState(state);
  if (diagnosticLogger.isEnabled("debug")) {
    diagnosticLogger.debug(
      `message queued: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
        state.sessionKey ?? "unknown"
      } source=${params.source} queueDepth=${state.queueDepth} sessionState=${state.state}`,
    );
  }
  emitDiagnosticEvent({
    type: "message.queued",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    channel: params.channel,
    source: params.source,
    queueDepth: state.queueDepth,
  });
  markDiagnosticActivity();
}

export function logLaneEnqueue(lane: string, queueSize: number): void {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  diagnosticLogger.debug(`lane enqueue: lane=${lane} queueSize=${queueSize}`);
  emitDiagnosticEvent({
    type: "queue.lane.enqueue",
    lane,
    queueSize,
  });
  markDiagnosticActivity();
}

export function logLaneDequeue(lane: string, waitMs: number, queueSize: number): void {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  diagnosticLogger.debug(`lane dequeue: lane=${lane} waitMs=${waitMs} queueSize=${queueSize}`);
  emitDiagnosticEvent({
    type: "queue.lane.dequeue",
    lane,
    queueSize,
    waitMs,
  });
  markDiagnosticActivity();
}
