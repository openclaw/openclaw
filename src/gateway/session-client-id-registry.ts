/**
 * Maps an operator/webchat session key to the gateway `client.id` of the
 * connection that most recently started an agent turn for that session.
 *
 * The loopback MCP tool resolver only receives a session key (via the
 * `x-session-key` header the CLI runner forwards). To apply per-client-id tool
 * restrictions (`gateway.tools.byClientId`), it needs to know which client
 * drove the turn. The operator turn entry point (`chat.send`) knows the
 * connecting client's id, so it records the association here just before
 * dispatching the agent run, and the loopback resolver reads it back.
 *
 * This is a RESTRICTION-only signal: it can only narrow the tool set for a
 * turn, never widen it. A client lying about its id can at most restrict
 * itself, so no trust is placed in the value.
 *
 * Entries are bounded: each carries a timestamp, is honored only within a TTL
 * that comfortably outlasts a turn, and the map is capped (oldest evicted). This
 * keeps the map small on a long-lived gateway and bounds how long a stale id
 * from a prior turn could be reused if an unrelated turn for the same session
 * key later reaches the loopback resolver. (Binding the id to the run-context
 * lifecycle would close that window entirely; left as a follow-up.)
 */
const ENTRY_TTL_MS = 15 * 60_000;
const MAX_ENTRIES = 512;

type Entry = { clientId: string; time: number };
const sessionKeyToClientId = new Map<string, Entry>();

/** Record (or clear) the client.id that owns the next agent turn for a session. */
export function setSessionOperatorClientId(
  sessionKey: string,
  clientId: string | undefined | null,
): void {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  const normalized = typeof clientId === "string" ? clientId.trim() : "";
  if (!normalized) {
    sessionKeyToClientId.delete(key);
    return;
  }
  sessionKeyToClientId.set(key, { clientId: normalized, time: Date.now() });
  if (sessionKeyToClientId.size > MAX_ENTRIES) {
    // Map preserves insertion order; drop the oldest entries down to the cap.
    for (const oldestKey of sessionKeyToClientId.keys()) {
      sessionKeyToClientId.delete(oldestKey);
      if (sessionKeyToClientId.size <= MAX_ENTRIES) {
        break;
      }
    }
  }
}

/** Look up the client.id last associated with a session, if any and still fresh. */
export function getSessionOperatorClientId(sessionKey: string): string | undefined {
  const key = sessionKey.trim();
  if (!key) {
    return undefined;
  }
  const entry = sessionKeyToClientId.get(key);
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.time >= ENTRY_TTL_MS) {
    sessionKeyToClientId.delete(key);
    return undefined;
  }
  return entry.clientId;
}

/** Test-only: reset the registry. */
export function resetSessionOperatorClientIdsForTest(): void {
  sessionKeyToClientId.clear();
}
