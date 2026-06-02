import type { OpenClawConfig } from "../config/types.openclaw.js";

/**
 * Session state retained between `session_start` and `session_end` so shutdown
 * can emit a final typed end event for still-active sessions.
 */
export type ActiveSessionForShutdown = {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId: string;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
};

const trackedSessions = new Map<string, ActiveSessionForShutdown>();

/**
 * Marks a session as needing shutdown finalization. Membership is keyed by
 * `sessionId`, so reset/delete/compaction can forget exactly the session that
 * already received its paired `session_end`.
 */
export function noteActiveSessionForShutdown(entry: ActiveSessionForShutdown): void {
  if (!entry.sessionId) {
    return;
  }
  trackedSessions.set(entry.sessionId, entry);
}

/**
 * Removes a session from the shutdown drain set after a normal lifecycle end.
 * This prevents reset/delete/compaction from double-firing `session_end` when
 * the process later exits.
 */
export function forgetActiveSessionForShutdown(sessionId: string | undefined): void {
  if (!sessionId) {
    return;
  }
  trackedSessions.delete(sessionId);
}

/**
 * Returns a snapshot of sessions that started but have not yet ended. The
 * shutdown drain consumes this list and clears entries as it emits hooks.
 */
export function listActiveSessionsForShutdown(): ActiveSessionForShutdown[] {
  return Array.from(trackedSessions.values());
}

/**
 * Clears process-local shutdown tracking between tests or runtime resets.
 */
export function clearActiveSessionsForShutdownTracker(): void {
  trackedSessions.clear();
}
