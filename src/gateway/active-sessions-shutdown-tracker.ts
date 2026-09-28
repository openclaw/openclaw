// Active session shutdown tracker.
// Remembers sessions needing `session_end` hooks during gateway shutdown/restart.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";

// Session lifecycle hooks track unmatched session_start events here. Reset,
// replace, delete, and compaction forget finalized sessions before shutdown,
// preventing the drain from emitting a second session_end.

type ActiveSessionForShutdown = {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId: string;
  storePath: string;
  sessionFile?: string;
  agentId: string;
};

const trackedSessions = resolveGlobalMap<string, ActiveSessionForShutdown>(
  Symbol.for("openclaw.activeSessionsForShutdown"),
  "close-and-restart",
);

export function noteActiveSessionForShutdown(entry: ActiveSessionForShutdown): void {
  if (!entry.sessionId) {
    return;
  }
  trackedSessions.set(entry.sessionId, entry);
}

export function forgetActiveSessionForShutdown(sessionId: string | undefined): void {
  if (!sessionId) {
    return;
  }
  trackedSessions.delete(sessionId);
}

export function listActiveSessionsForShutdown(): ActiveSessionForShutdown[] {
  // Return a snapshot, not the backing map, so shutdown drains can iterate while
  // lifecycle hooks concurrently forget finalized sessions.
  return Array.from(trackedSessions.values());
}
