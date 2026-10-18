import { getDatabaseProcessRole } from "./database-engine/admission-scope.js";

/** Idle native connections share one retention window across SQLite owners. */
export const SQLITE_IDLE_HANDLE_TTL_MS = 30 * 60_000;

/** Reuses a handle across one command's bursts, well inside Doctor's lease wait. */
export const SQLITE_CLI_AGENT_IDLE_HANDLE_TTL_MS = 30_000;

/**
 * An idle agent database handle keeps its lease, and Doctor maintenance waits for
 * every lease. Nothing can tell an idle holder in another process that an update
 * is waiting, so CLI processes release soon after use instead of keeping the
 * shared window. Gateways keep it. Worker threads install no role and keep it
 * too: their parent thread's owner pins their handle and retires the Worker.
 */
export function resolveAgentDatabaseIdleHandleTtlMs(): number {
  return getDatabaseProcessRole() === "cli-oneshot"
    ? SQLITE_CLI_AGENT_IDLE_HANDLE_TTL_MS
    : SQLITE_IDLE_HANDLE_TTL_MS;
}
