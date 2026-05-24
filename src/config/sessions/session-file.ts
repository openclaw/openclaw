import { resolveSessionFilePath } from "./paths.js";
import { preserveChangedPendingFinalDeliveryFields } from "./pending-final-delivery-fields.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
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
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  allowSessionIdChange?: boolean;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry }> {
  const { sessionId, sessionKey, sessionStore, storePath } = params;
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
    let storedEntry = persistedEntry;
    await updateSessionStore(
      storePath,
      (store) => {
        const currentEntry = store[sessionKey];
        if (
          !params.allowSessionIdChange &&
          currentEntry &&
          currentEntry.sessionId !== baseEntry.sessionId
        ) {
          storedEntry = currentEntry;
          return;
        }
        storedEntry = preserveChangedPendingFinalDeliveryFields({
          next: persistedEntry,
          loaded: baseEntry,
          current: currentEntry,
        });
        store[sessionKey] = {
          ...currentEntry,
          ...storedEntry,
        };
      },
      params.activeSessionKey || params.maintenanceConfig
        ? {
            ...(params.activeSessionKey ? { activeSessionKey: params.activeSessionKey } : {}),
            ...(params.maintenanceConfig ? { maintenanceConfig: params.maintenanceConfig } : {}),
          }
        : undefined,
    );
    sessionStore[sessionKey] = storedEntry;
    return { sessionFile: storedEntry.sessionFile ?? sessionFile, sessionEntry: storedEntry };
  }
  sessionStore[sessionKey] = persistedEntry;
  return { sessionFile, sessionEntry: persistedEntry };
}
