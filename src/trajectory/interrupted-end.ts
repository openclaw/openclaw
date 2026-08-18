import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
// Records the canonical interrupted terminal event for sessions whose state
// owner marks them aborted outside the normal attempt-settle path (restart
// markers, force-cleared runs, admitted-recovery restorations). Callers must
// only invoke this after their state transition has committed, so a failed
// transition never fabricates one.
import { parseAgentSessionKey } from "../routing/session-key.js";
import { appendSqliteTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";
import { sanitizeTrajectoryPayload } from "./runtime.js";
import type { TrajectoryEvent } from "./types.js";

function buildInterruptedSessionTrajectoryEvent(params: {
  reason?: string;
  runId?: string;
  sessionId: string;
  sessionKey: string;
}): TrajectoryEvent {
  const data = sanitizeTrajectoryPayload({
    status: "interrupted",
    aborted: true,
    ...(params.reason ? { reason: params.reason } : {}),
  });
  const now = new Date();
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: params.sessionId,
    source: "runtime",
    type: "session.ended",
    ts: now.toISOString(),
    seq: 0,
    sourceSeq: 0,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: params.runId,
    data,
  };
}

/**
 * Synchronously appends the interrupted terminal event inside an already-open
 * session/trajectory SQLite write transaction. Use this when the event must be
 * atomic with the state transition that produced it.
 *
 * The SQLite target is resolved from the store path, so fixed/shared session
 * stores that physically belong to a single agent database record the event
 * under that owner rather than the logical session row's agent.
 */
export function appendInterruptedSessionTrajectoryEndSync(params: {
  env?: NodeJS.ProcessEnv;
  sessionKey: string;
  sessionId: string;
  storePath: string;
  agentId?: string;
  runId?: string;
  reason?: string;
}): void {
  const requestedAgentId = params.agentId ?? parseAgentSessionKey(params.sessionKey)?.agentId;
  if (!requestedAgentId) {
    return;
  }
  const target = resolveSqliteTargetFromSessionStorePath(params.storePath, {
    agentId: requestedAgentId,
    env: params.env,
  });
  const agentId = target.agentId ?? requestedAgentId;
  appendSqliteTrajectoryRuntimeEvents(
    {
      agentId,
      env: params.env ?? process.env,
      sessionId: params.sessionId,
      storePath: params.storePath,
    },
    [buildInterruptedSessionTrajectoryEvent(params)],
  );
}
