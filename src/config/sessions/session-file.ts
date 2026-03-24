import { resolveSessionFilePath } from "./paths.js";
import { updateSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

export async function resolveAndPersistSessionFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionsDir?: string;
  fallbackSessionFile?: string;
  activeSessionKey?: string;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry }> {
  const { sessionId, sessionKey, sessionStore, storePath } = params;
  const baseEntry = params.sessionEntry ??
    sessionStore[sessionKey] ?? { sessionId, updatedAt: Date.now() };
  const reusePersistedSessionFile =
    sessionId.trim().length > 0 && baseEntry.sessionId === sessionId;
  const fallbackSessionFile = params.fallbackSessionFile?.trim();
  let entryForResolve = baseEntry;
  // A new session ID must rotate off any stale persisted transcript path,
  // while same-session recovery can still seed a missing path from fallback.
  if (!reusePersistedSessionFile) {
    // New session: clear old path, optionally seed from fallback.
    entryForResolve = { ...baseEntry, sessionFile: fallbackSessionFile || undefined };
  } else if (!baseEntry.sessionFile && fallbackSessionFile) {
    // Same session: seed a missing path from fallback.
    entryForResolve = { ...baseEntry, sessionFile: fallbackSessionFile };
  }
  const sessionFile = resolveSessionFilePath(sessionId, entryForResolve, {
    agentId: params.agentId,
    sessionsDir: params.sessionsDir,
  });
  const persistedEntry: SessionEntry = {
    ...baseEntry,
    sessionId,
    updatedAt: Date.now(),
    sessionFile,
  };
  if (baseEntry.sessionId !== sessionId || baseEntry.sessionFile !== sessionFile) {
    sessionStore[sessionKey] = persistedEntry;
    await updateSessionStore(
      storePath,
      (store) => {
        store[sessionKey] = {
          ...store[sessionKey],
          ...persistedEntry,
        };
      },
      params.activeSessionKey ? { activeSessionKey: params.activeSessionKey } : undefined,
    );
    return { sessionFile, sessionEntry: persistedEntry };
  }
  sessionStore[sessionKey] = persistedEntry;
  return { sessionFile, sessionEntry: persistedEntry };
}
