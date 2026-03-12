import { resolveEmbeddedSessionLane } from "../agents/pi-embedded-runner/lanes.js";
import {
  diagnosticSessionStates,
  pruneDiagnosticSessionStates,
  type SessionStateValue,
} from "../logging/diagnostic-session-state.js";
import {
  getCommandQueueSnapshot,
  type CommandQueueLaneSnapshot,
} from "../process/command-queue.js";

export type QueueDiagnosticsSessionSnapshot = {
  sessionId?: string;
  sessionKey?: string;
  lane: string | null;
  state: SessionStateValue;
  queueDepth: number;
  lastActivityAgeMs: number;
  stuck: boolean;
};

export type QueueDiagnosticsSnapshot = {
  ts: number;
  stuckSessionWarnMs: number;
  summary: {
    lanes: number;
    queued: number;
    active: number;
    draining: number;
    sessions: number;
    stuckSessions: number;
  };
  lanes: CommandQueueLaneSnapshot[];
  sessions: QueueDiagnosticsSessionSnapshot[];
};

function shouldIncludeSession(params: {
  includeIdle: boolean;
  state: SessionStateValue;
  queueDepth: number;
  laneSnapshot?: CommandQueueLaneSnapshot;
}) {
  if (params.includeIdle) {
    return true;
  }
  if (params.state !== "idle" || params.queueDepth > 0) {
    return true;
  }
  return (
    (params.laneSnapshot?.active ?? 0) > 0 ||
    (params.laneSnapshot?.queued ?? 0) > 0 ||
    params.laneSnapshot?.draining === true
  );
}

export function buildQueueDiagnosticsSnapshot(params: {
  includeIdle?: boolean;
  stuckSessionWarnMs: number;
  now?: number;
}): QueueDiagnosticsSnapshot {
  const now = params.now ?? Date.now();
  const includeIdle = params.includeIdle === true;
  const lanes = getCommandQueueSnapshot({ includeIdle, now });
  const laneByName = new Map(lanes.map((lane) => [lane.lane, lane]));

  pruneDiagnosticSessionStates(now, true);
  const sessions: QueueDiagnosticsSessionSnapshot[] = [];
  for (const state of diagnosticSessionStates.values()) {
    const lane =
      typeof state.sessionKey === "string" && state.sessionKey.trim()
        ? resolveEmbeddedSessionLane(state.sessionKey)
        : typeof state.sessionId === "string" && state.sessionId.trim()
          ? resolveEmbeddedSessionLane(state.sessionId)
          : null;
    const laneSnapshot = lane ? laneByName.get(lane) : undefined;
    if (
      !shouldIncludeSession({
        includeIdle,
        state: state.state,
        queueDepth: state.queueDepth,
        laneSnapshot,
      })
    ) {
      continue;
    }

    const lastActivityAgeMs = Math.max(0, now - state.lastActivity);
    sessions.push({
      sessionId: state.sessionId,
      sessionKey: state.sessionKey,
      lane,
      state: state.state,
      queueDepth: state.queueDepth,
      lastActivityAgeMs,
      stuck: state.state === "processing" && lastActivityAgeMs > params.stuckSessionWarnMs,
    });
  }

  sessions.sort((a, b) => {
    if (a.stuck !== b.stuck) {
      return a.stuck ? -1 : 1;
    }
    if (a.state !== b.state) {
      if (a.state === "processing") {
        return -1;
      }
      if (b.state === "processing") {
        return 1;
      }
      if (a.state === "waiting") {
        return -1;
      }
      if (b.state === "waiting") {
        return 1;
      }
    }
    if (a.queueDepth !== b.queueDepth) {
      return b.queueDepth - a.queueDepth;
    }
    if (a.lastActivityAgeMs !== b.lastActivityAgeMs) {
      return b.lastActivityAgeMs - a.lastActivityAgeMs;
    }
    return String(a.sessionKey ?? a.sessionId ?? "").localeCompare(
      String(b.sessionKey ?? b.sessionId ?? ""),
    );
  });

  return {
    ts: now,
    stuckSessionWarnMs: params.stuckSessionWarnMs,
    summary: {
      lanes: lanes.length,
      queued: lanes.reduce((sum, lane) => sum + lane.queued, 0),
      active: lanes.reduce((sum, lane) => sum + lane.active, 0),
      draining: lanes.filter((lane) => lane.draining).length,
      sessions: sessions.length,
      stuckSessions: sessions.filter((session) => session.stuck).length,
    },
    lanes,
    sessions,
  };
}
