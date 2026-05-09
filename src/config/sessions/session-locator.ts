import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getSessionEntry, upsertSessionEntry } from "./store.js";
import type { SessionEntry } from "./types.js";

export async function resolveAndPersistSessionTranscriptScope(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry?: SessionEntry;
  agentId?: string;
  topicId?: string | number;
}): Promise<{ agentId: string; sessionId: string; sessionEntry: SessionEntry }> {
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
  const persistedEntry: SessionEntry = {
    ...baseEntry,
    sessionId,
    updatedAt: now,
    sessionStartedAt: baseEntry.sessionId === sessionId ? (baseEntry.sessionStartedAt ?? now) : now,
  };
  const { transcriptLocator: _derivedTranscriptLocator, ...entryWithoutDerivedLocator } =
    persistedEntry as SessionEntry & { transcriptLocator?: unknown };
  if (
    baseEntry.sessionId !== sessionId ||
    "transcriptLocator" in (baseEntry as SessionEntry & { transcriptLocator?: unknown })
  ) {
    upsertSessionEntry({
      agentId,
      sessionKey,
      entry: entryWithoutDerivedLocator,
    });
    return { agentId, sessionId, sessionEntry: entryWithoutDerivedLocator };
  }
  return { agentId, sessionId, sessionEntry: entryWithoutDerivedLocator };
}
