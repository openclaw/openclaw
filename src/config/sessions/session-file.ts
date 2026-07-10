// Session file persistence resolves transcript paths and syncs store metadata.
import path from "node:path";
import { resolveSessionFilePath } from "./paths.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import { updateSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

/** Resolves a transcript file path and persists it into the session store when needed. */
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
  const baseEntry = params.sessionEntry ??
    sessionStore[sessionKey] ?? { sessionId, updatedAt: now, sessionStartedAt: now };
  const shouldReusePersistedSessionFile = baseEntry.sessionId === sessionId;
  const fallbackSessionFile = params.fallbackSessionFile?.trim();
  // Callers build `fallbackSessionFile` from the default agents dir, but a new
  // session's transcript should live in the configured store dir (= dirname(store),
  // passed as `sessionsDir`) — which is where session-store maintenance
  // (cleanup-service / disk-budget) already looks. Re-root the fallback onto
  // `sessionsDir` so a relocated `session.store` is honored for the primary
  // transcript, not just the index and the mirror path (fixed in #95782). The
  // topic id lives in the basename, so it is preserved; this is a no-op when
  // `sessionsDir` already equals the fallback's dir (the default layout).
  const rerootedFallback =
    fallbackSessionFile && params.sessionsDir
      ? path.join(params.sessionsDir, path.basename(fallbackSessionFile))
      : fallbackSessionFile;
  // A reset/fork should not reuse the previous transcript path unless the fallback explicitly
  // points at the intended file for the new session id.
  const entryForResolve = !shouldReusePersistedSessionFile
    ? rerootedFallback
      ? { ...baseEntry, sessionFile: rerootedFallback }
      : { ...baseEntry, sessionFile: undefined }
    : !baseEntry.sessionFile && rerootedFallback
      ? { ...baseEntry, sessionFile: rerootedFallback }
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
