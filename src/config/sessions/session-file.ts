import path from "node:path";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveSessionFilePath } from "./paths.js";
import { getSessionEntry, upsertSessionEntry } from "./store.js";
import type { SessionEntry } from "./types.js";

export async function resolveAndPersistSessionFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionsDir?: string;
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
  const shouldReusePersistedSessionFile = baseEntry.sessionId === sessionId;
  const fallbackSessionFile = params.fallbackSessionFile?.trim();
  const entryForResolve = !shouldReusePersistedSessionFile
    ? fallbackSessionFile
      ? { ...baseEntry, sessionFile: fallbackSessionFile }
      : { ...baseEntry, sessionFile: undefined }
    : !baseEntry.sessionFile && fallbackSessionFile
      ? { ...baseEntry, sessionFile: fallbackSessionFile }
      : baseEntry;
  const sessionFile =
    fallbackSessionFile && !params.sessionsDir
      ? path.resolve(fallbackSessionFile)
      : resolveSessionFilePath(sessionId, entryForResolve, {
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
    upsertSessionEntry({
      agentId,
      sessionKey,
      entry: persistedEntry,
    });
    return { sessionFile, sessionEntry: persistedEntry };
  }
  return { sessionFile, sessionEntry: persistedEntry };
}
