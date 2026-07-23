import { normalizeAgentId } from "../../routing/session-key.js";

const incognitoSessions = new Map<string, string>();
const retiredIncognitoSessions = new Map<string, string>();

// This registry intentionally shares the Gateway process lifetime with the in-memory
// database cache; losing both on restart is the incognito deletion contract.
export function registerIncognitoSession(sessionKey: string, agentId: string): void {
  const key = sessionKey.trim();
  retiredIncognitoSessions.delete(key);
  incognitoSessions.set(key, normalizeAgentId(agentId));
}

export function lookupIncognitoSessionAgentId(sessionKey: string): string | undefined {
  const key = sessionKey.trim();
  return incognitoSessions.get(key) ?? retiredIncognitoSessions.get(key);
}

export function unregisterIncognitoSession(sessionKey: string): boolean {
  const key = sessionKey.trim();
  const agentId = incognitoSessions.get(key);
  if (!agentId) {
    return false;
  }
  incognitoSessions.delete(key);
  // A stale client may keep using the deleted key. Retain only its routing tombstone
  // so it can fail or rematerialize in memory, never fall through to durable storage.
  retiredIncognitoSessions.set(key, agentId);
  return true;
}

export function listIncognitoSessionsForAgent(agentId: string): string[] {
  const normalizedAgentId = normalizeAgentId(agentId);
  return [...incognitoSessions]
    .flatMap(([sessionKey, ownerAgentId]) =>
      ownerAgentId === normalizedAgentId ? [sessionKey] : [],
    )
    .toSorted();
}
