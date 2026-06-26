// Session file persistence syncs active session transcript markers into store metadata.
import { normalizeAgentId } from "../../routing/session-key.js";
import { formatSqliteSessionFileMarker } from "./sqlite-marker.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import { updateSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

/** Resolves the active SQLite transcript marker and persists it into the session store when needed. */
export async function resolveAndPersistSessionFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  sessionEntry?: SessionEntry;
  agentId?: string;
  activeSessionKey?: string;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry }> {
  const { sessionId, sessionKey, sessionStore, storePath } = params;
  const now = Date.now();
  const baseEntry = params.sessionEntry ??
    sessionStore[sessionKey] ?? { sessionId, updatedAt: now, sessionStartedAt: now };
  const sessionFile = formatSqliteSessionFileMarker({
    agentId: normalizeAgentId(params.agentId),
    sessionId,
    storePath,
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
    await updateSessionStore(
      storePath,
      (store) => {
        store[sessionKey] = {
          ...store[sessionKey],
          ...persistedEntry,
        };
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
  sessionStore[sessionKey] = persistedEntry;
  return { sessionFile, sessionEntry: persistedEntry };
}
