import {
  areDiagnosticsEnabledForProcess,
  emitInternalDiagnosticEvent as emitDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticSessionState,
  peekDiagnosticSessionState,
  touchDiagnosticSessionState,
  type SessionRef,
  type SessionStateValue,
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

/** @internal Test-support reset; see diagnostic.test-support.ts. */
export function resetDiagnosticActivityForTest(): void {
  lastActivityAt = 0;
}

/** Records queue activity while letting internal run owners distinguish steering from backlog. */
export function logMessageQueuedWithBacklogPolicy(
  params: SessionRef & {
    channel?: string;
    source: string;
  },
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
  emitDiagnosticEvent({
    type: "queue.lane.dequeue",
    lane,
    queueSize,
    waitMs,
  });
  markDiagnosticActivity();
}

export function logSessionStateChange(
  params: SessionRef & {
    state: SessionStateValue;
    reason?: string;
    /** Message lifecycle owns its queue count; controller retirement only projects idle. */
    consumeQueuedTurn?: boolean;
  },
) {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  // Controller retirement observes existing state; message lifecycle owns its identity.
  const projectsIdle = params.state === "idle" && params.consumeQueuedTurn === false;
  const state = projectsIdle
    ? peekDiagnosticSessionState(params)
    : getDiagnosticSessionState(params);
  if (!state || (projectsIdle && state.state === "idle")) {
    return;
  }
  const prevState = state.state;
  state.state = params.state;
  touchDiagnosticSessionState(state);
  if (params.state === "processing" && prevState !== "processing") {
    state.activeQueuedTurn = state.queueDepth > 0;
  }
  if (params.state === "idle") {
    if (params.consumeQueuedTurn !== false) {
      state.queueDepth = Math.max(0, state.queueDepth - 1);
    }
    state.activeQueuedTurn = false;
  }
  emitDiagnosticEvent({
    type: "session.state",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    prevState,
    state: params.state,
    reason: params.reason,
    queueDepth: state.queueDepth,
  });
  markDiagnosticActivity();
}
