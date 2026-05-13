import {
  getSessionEntry,
  mergeSessionEntry,
  resolveAgentIdFromSessionKey,
  type SessionEntry,
  upsertSessionEntry,
} from "../../config/sessions.js";

export function readSessionEntryRow(params: {
  sessionKey?: string;
  fallbackEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
}): SessionEntry | undefined {
  const { sessionKey } = params;
  if (!sessionKey) {
    return params.fallbackEntry;
  }
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const entry =
    getSessionEntry({ agentId, sessionKey }) ??
    params.sessionStore?.[sessionKey] ??
    params.fallbackEntry;
  if (entry && params.sessionStore) {
    params.sessionStore[sessionKey] = entry;
  }
  return entry;
}

export async function writeSessionEntryRow(params: {
  sessionKey?: string;
  fallbackEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  update: (
    entry: SessionEntry,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
}): Promise<SessionEntry | null> {
  const { sessionKey } = params;
  if (!sessionKey) {
    return null;
  }
  const existing = readSessionEntryRow(params);
  if (!existing) {
    return null;
  }
  const patch = await params.update(existing);
  if (!patch) {
    return existing;
  }
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const next = mergeSessionEntry(existing, patch);
  upsertSessionEntry({ agentId, sessionKey, entry: next });
  if (params.sessionStore) {
    params.sessionStore[sessionKey] = next;
  }
  return next;
}
