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
  const storeEntry = sessionStore[sessionKey];
  const baseEntry = params.sessionEntry ??
    storeEntry ?? { sessionId, updatedAt: Date.now() };
  const fallbackSessionFile = params.fallbackSessionFile?.trim();
  const preserveExistingSessionFile = (storeEntry?.sessionId ?? baseEntry.sessionId) === sessionId;
  const entryForResolve =
    !preserveExistingSessionFile && baseEntry.sessionFile
      ? { ...baseEntry, sessionFile: undefined }
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
