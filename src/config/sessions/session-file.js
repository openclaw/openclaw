import { resolveSessionFilePath } from "./paths.js";
import { updateSessionStore } from "./store.js";
export async function resolveAndPersistSessionFile(params) {
    const { sessionId, sessionKey, sessionStore, storePath } = params;
    const baseEntry = params.sessionEntry ??
        sessionStore[sessionKey] ?? { sessionId, updatedAt: Date.now() };
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
    const persistedEntry = {
        ...baseEntry,
        sessionId,
        updatedAt: Date.now(),
        sessionFile,
    };
    if (baseEntry.sessionId !== sessionId || baseEntry.sessionFile !== sessionFile) {
        sessionStore[sessionKey] = persistedEntry;
        await updateSessionStore(storePath, (store) => {
            store[sessionKey] = {
                ...store[sessionKey],
                ...persistedEntry,
            };
        }, params.activeSessionKey || params.maintenanceConfig
            ? {
                ...(params.activeSessionKey ? { activeSessionKey: params.activeSessionKey } : {}),
                ...(params.maintenanceConfig ? { maintenanceConfig: params.maintenanceConfig } : {}),
            }
            : undefined);
        return { sessionFile, sessionEntry: persistedEntry };
    }
    sessionStore[sessionKey] = persistedEntry;
    return { sessionFile, sessionEntry: persistedEntry };
}
