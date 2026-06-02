import type { OpenClawConfig } from "../config/types.openclaw.js";

// Module-level tracker of sessions that have received `session_start` but not
// yet a paired `session_end`. The close handler drains this set on gateway
// shutdown / restart so downstream `session_end` plugins (e.g. claude-mem)
// can finalize sessions that were active when the process stopped, instead
// of leaving ghost rows in `active` state across restarts (see #57790).
//
// Membership is keyed by `sessionId`. The existing session lifecycle paths
// (`emitGatewaySessionStartPluginHook` /
// `emitGatewaySessionEndPluginHook` in `session-reset-service.ts`) call into
// this tracker so a session that has already been finalized by replace /
// reset / delete / compaction is forgotten before the shutdown drain ever
// runs. That is what keeps the shutdown finalizer from double-firing.

export type ActiveSessionForShutdown = {
  /** Config snapshot used to build the eventual shutdown session_end payload. */
  cfg: OpenClawConfig;
  /** Canonical session key that received session_start. */
  sessionKey: string;
  /** Durable run/session id used as the tracker identity. */
  sessionId: string;
  /** Session store path used to resolve transcript candidates at drain time. */
  storePath: string;
  /** Optional persisted/custom transcript file path from the active session. */
  sessionFile?: string;
  /** Agent scope used for per-agent transcript path resolution. */
  agentId?: string;
};

const trackedSessions = new Map<string, ActiveSessionForShutdown>();

/** Track a session_start that may need a paired session_end during shutdown. */
export function noteActiveSessionForShutdown(entry: ActiveSessionForShutdown): void {
  if (!entry.sessionId) {
    return;
  }
  trackedSessions.set(entry.sessionId, entry);
}

/** Forget a finalized session so the shutdown drain cannot double-fire it. */
export function forgetActiveSessionForShutdown(sessionId: string | undefined): void {
  if (!sessionId) {
    return;
  }
  trackedSessions.delete(sessionId);
}

/** Return a snapshot of sessions still awaiting shutdown finalization. */
export function listActiveSessionsForShutdown(): ActiveSessionForShutdown[] {
  return Array.from(trackedSessions.values());
}

/** Clear shutdown tracker state for tests and process-local reset hooks. */
export function clearActiveSessionsForShutdownTracker(): void {
  trackedSessions.clear();
}
