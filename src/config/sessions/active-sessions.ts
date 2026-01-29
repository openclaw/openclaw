/**
 * Active session tracking to prevent GC from deleting sessions that are currently in use.
 *
 * This module maintains a registry of active sessions with heartbeat tracking.
 * Sessions must be marked active before use and inactive after completion.
 * GC checks this registry before deleting sessions.
 */

interface ActiveSessionEntry {
  sessionKey: string;
  agentId: string;
  pid: number;
  startedAt: number;
  lastHeartbeat: number;
}

const ACTIVE_SESSIONS = new Map<string, ActiveSessionEntry>();

/**
 * How long since last heartbeat before a session is considered stale (5 minutes).
 */
const STALE_PERIOD_MS = 5 * 60 * 1000;

/**
 * Mark a session as active. Call this when an agent starts using a session.
 *
 * @param sessionKey - The session key (e.g., "user:123" or "global")
 * @param agentId - The agent ID (e.g., "liam-telegram")
 */
export function markSessionActive(sessionKey: string, agentId: string): void {
  ACTIVE_SESSIONS.set(sessionKey, {
    sessionKey,
    agentId,
    pid: process.pid,
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
  });
}

/**
 * Update the heartbeat timestamp for an active session.
 * Call this periodically during long-running operations (every 30s recommended).
 *
 * @param sessionKey - The session key to update
 */
export function updateSessionHeartbeat(sessionKey: string): void {
  const entry = ACTIVE_SESSIONS.get(sessionKey);
  if (entry) {
    entry.lastHeartbeat = Date.now();
  }
}

/**
 * Mark a session as inactive. Call this when an agent finishes using a session.
 *
 * @param sessionKey - The session key to mark inactive
 */
export function markSessionInactive(sessionKey: string): void {
  ACTIVE_SESSIONS.delete(sessionKey);
}

/**
 * Check if a session is currently active.
 * A session is considered active if:
 * 1. It's in the active sessions registry
 * 2. Its last heartbeat was within the stale period (5 minutes)
 *
 * @param sessionKey - The session key to check
 * @returns true if the session is active, false otherwise
 */
export function isSessionActive(sessionKey: string): boolean {
  const entry = ACTIVE_SESSIONS.get(sessionKey);
  if (!entry) return false;

  // Check if heartbeat is stale
  const timeSinceHeartbeat = Date.now() - entry.lastHeartbeat;
  return timeSinceHeartbeat < STALE_PERIOD_MS;
}

/**
 * Get information about all active sessions (for debugging/monitoring).
 *
 * @returns Array of active session entries
 */
export function getActiveSessions(): ActiveSessionEntry[] {
  return Array.from(ACTIVE_SESSIONS.values());
}

/**
 * Get information about a specific active session.
 *
 * @param sessionKey - The session key to look up
 * @returns The active session entry, or undefined if not active
 */
export function getActiveSession(sessionKey: string): ActiveSessionEntry | undefined {
  return ACTIVE_SESSIONS.get(sessionKey);
}

/**
 * Clean up stale entries from the active sessions registry.
 * This is a maintenance operation that should be called periodically.
 *
 * @returns Number of stale entries removed
 */
export function cleanupStaleActiveSessions(): number {
  let removed = 0;
  const now = Date.now();

  for (const [key, entry] of ACTIVE_SESSIONS.entries()) {
    const timeSinceHeartbeat = now - entry.lastHeartbeat;
    if (timeSinceHeartbeat >= STALE_PERIOD_MS) {
      ACTIVE_SESSIONS.delete(key);
      removed++;
    }
  }

  return removed;
}
