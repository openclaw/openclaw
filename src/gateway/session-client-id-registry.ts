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
 */
const sessionKeyToClientId = new Map<string, string>();

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
  sessionKeyToClientId.set(key, normalized);
}

/** Look up the client.id last associated with a session, if any. */
export function getSessionOperatorClientId(sessionKey: string): string | undefined {
  const key = sessionKey.trim();
  if (!key) {
    return undefined;
  }
  return sessionKeyToClientId.get(key);
}

/** Test-only: reset the registry. */
export function resetSessionOperatorClientIdsForTest(): void {
  sessionKeyToClientId.clear();
}
