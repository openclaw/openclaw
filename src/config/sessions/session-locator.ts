import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { createSqliteSessionTranscriptLocator } from "./paths.js";
import { getSessionEntry, upsertSessionEntry } from "./store.js";
import type { SessionEntry } from "./types.js";

export async function resolveAndPersistSessionTranscriptIdentity(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry?: SessionEntry;
  agentId?: string;
  topicId?: string | number;
}): Promise<{ transcriptLocator: string; sessionEntry: SessionEntry }> {
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
  const transcriptLocator = createSqliteSessionTranscriptLocator({
    agentId,
    sessionId,
    topicId: params.topicId,
  });
  const persistedEntry: SessionEntry = {
    ...baseEntry,
    sessionId,
    updatedAt: now,
    sessionStartedAt: baseEntry.sessionId === sessionId ? (baseEntry.sessionStartedAt ?? now) : now,
  };
  const { transcriptLocator: _derivedTranscriptLocator, ...entryWithoutDerivedLocator } =
    persistedEntry;
  if (baseEntry.sessionId !== sessionId || baseEntry.transcriptLocator) {
    upsertSessionEntry({
      agentId,
      sessionKey,
      entry: entryWithoutDerivedLocator,
    });
    return { transcriptLocator, sessionEntry: entryWithoutDerivedLocator };
  }
  return { transcriptLocator, sessionEntry: entryWithoutDerivedLocator };
}
