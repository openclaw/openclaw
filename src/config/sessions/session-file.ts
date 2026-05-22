import { resolveSessionFilePath } from "./paths.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import { resolveSessionStoreEntry, updateSessionStore } from "./store.js";
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
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry }> {
  const { sessionId, sessionKey, sessionStore, storePath } = params;
  const now = Date.now();
  const memResolved = resolveSessionStoreEntry({ store: sessionStore, sessionKey });
  const baseEntry = params.sessionEntry ??
    memResolved.existing ?? { sessionId, updatedAt: now, sessionStartedAt: now };
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
    sessionStore[memResolved.normalizedKey] = persistedEntry;
    for (const legacyKey of memResolved.legacyKeys) {
      delete sessionStore[legacyKey];
    }
    await updateSessionStore(
      storePath,
      (store) => {
        const resolved = resolveSessionStoreEntry({ store, sessionKey });
        store[resolved.normalizedKey] = {
          ...resolved.existing,
          ...persistedEntry,
        };
        for (const legacyKey of resolved.legacyKeys) {
          delete store[legacyKey];
        }
      },
      params.activeSessionKey || params.maintenanceConfig
        ? {
            ...(params.activeSessionKey ? { activeSessionKey: params.activeSessionKey } : {}),
            ...(params.maintenanceConfig ? { maintenanceConfig: params.maintenanceConfig } : {}),
          }
        : undefined,
    );
    return { sessionFile, sessionEntry: persistedEntry };
  }
  sessionStore[memResolved.normalizedKey] = persistedEntry;
  for (const legacyKey of memResolved.legacyKeys) {
    delete sessionStore[legacyKey];
  }
  return { sessionFile, sessionEntry: persistedEntry };
}
