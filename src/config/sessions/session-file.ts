import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { createSqliteSessionTranscriptLocator, isSqliteSessionTranscriptLocator } from "./paths.js";
import { getSessionEntry, upsertSessionEntry } from "./store.js";
import type { SessionEntry } from "./types.js";

export async function resolveAndPersistSessionFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry?: SessionEntry;
  agentId?: string;
  fallbackSessionFile?: string;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry }> {
  const { sessionId, sessionKey } = params;
  const now = Date.now();
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  if (!agentId) {
    throw new Error(`Session stores are SQLite-only; cannot resolve agent for ${sessionKey}`);
  }
  const baseEntry = params.sessionEntry ??
    getSessionEntry({ agentId, sessionKey }) ?? {
      sessionId,
      updatedAt: now,
      sessionStartedAt: now,
    };
  const persistedSessionFile = baseEntry.sessionFile?.trim();
  const shouldReusePersistedSessionFile =
    baseEntry.sessionId === sessionId && isSqliteSessionTranscriptLocator(persistedSessionFile);
  const fallbackSessionFile = params.fallbackSessionFile?.trim();
  const sessionFile = shouldReusePersistedSessionFile
    ? persistedSessionFile!
    : fallbackSessionFile && isSqliteSessionTranscriptLocator(fallbackSessionFile)
      ? fallbackSessionFile
      : createSqliteSessionTranscriptLocator({ agentId, sessionId });
  const persistedEntry: SessionEntry = {
    ...baseEntry,
    sessionId,
    updatedAt: now,
    sessionStartedAt: baseEntry.sessionId === sessionId ? (baseEntry.sessionStartedAt ?? now) : now,
    sessionFile,
  };
  if (baseEntry.sessionId !== sessionId || baseEntry.sessionFile !== sessionFile) {
    upsertSessionEntry({
      agentId,
      sessionKey,
      entry: persistedEntry,
    });
    return { sessionFile, sessionEntry: persistedEntry };
  }
  return { sessionFile, sessionEntry: persistedEntry };
}
