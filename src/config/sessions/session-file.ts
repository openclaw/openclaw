import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveSessionFilePath } from "./paths.js";
import { upsertSessionEntry } from "./store.js";
import type { SessionEntry } from "./types.js";

export async function resolveAndPersistSessionFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionsDir?: string;
  fallbackSessionFile?: string;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry }> {
  const { sessionId, sessionKey, sessionStore } = params;
  const now = Date.now();
  const baseEntry = params.sessionEntry ??
    sessionStore[sessionKey] ?? { sessionId, updatedAt: now, sessionStartedAt: now };
  const shouldReusePersistedSessionFile = baseEntry.sessionId === sessionId;
  const fallbackSessionFile = params.fallbackSessionFile?.trim();
  const entryForResolve = !shouldReusePersistedSessionFile
    ? fallbackSessionFile
      ? { ...baseEntry, sessionFile: fallbackSessionFile }
      : { ...baseEntry, sessionFile: undefined }
    : !baseEntry.sessionFile && fallbackSessionFile
      ? { ...baseEntry, sessionFile: fallbackSessionFile }
      : baseEntry;
  const sessionFile = resolveSessionFilePath(sessionId, entryForResolve, {
    agentId: params.agentId,
    sessionsDir: params.sessionsDir,
  });
  const persistedEntry: SessionEntry = {
    ...baseEntry,
    sessionId,
    updatedAt: now,
    sessionStartedAt: baseEntry.sessionId === sessionId ? (baseEntry.sessionStartedAt ?? now) : now,
    sessionFile,
  };
  if (baseEntry.sessionId !== sessionId || baseEntry.sessionFile !== sessionFile) {
    sessionStore[sessionKey] = persistedEntry;
    const agentId = params.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
    if (!agentId) {
      throw new Error(`Session stores are SQLite-only; cannot resolve agent for ${sessionKey}`);
    }
    upsertSessionEntry({
      agentId,
      sessionKey,
      entry: persistedEntry,
    });
    return { sessionFile, sessionEntry: persistedEntry };
  }
  sessionStore[sessionKey] = persistedEntry;
  return { sessionFile, sessionEntry: persistedEntry };
}
