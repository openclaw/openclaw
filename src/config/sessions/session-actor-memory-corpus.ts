import { projectSessionEntryRecord } from "../../../packages/memory-host-sdk/src/host/session-entry-projection.js";
import { resolveSessionResetRecallCutoff } from "../../../packages/memory-host-sdk/src/host/session-reset-recall.js";
import type {
  SessionActorMemoryCorpusQuery,
  SessionActorMemoryCorpusReads,
} from "./session-actor-memory-corpus-contract.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import { readSessionActorMemoryTranscriptStats } from "./session-actor-memory-usage.js";

/** Select once from owned windows, retaining only the Memory projection requested by the caller. */
export function readSessionActorMemoryCorpus(
  context: SessionActorMemoryStorageContext,
  query: SessionActorMemoryCorpusQuery,
): SessionActorMemoryCorpusReads[keyof SessionActorMemoryCorpusReads]["output"] {
  const selectedKey =
    query.input.sessionKey ??
    (query.input.sessionId === undefined ? context.state.hot.target.sessionKey : undefined);
  for (const [sessionKey, state] of context.entries()) {
    if (selectedKey !== undefined && selectedKey !== sessionKey) {
      continue;
    }
    const window =
      query.input.sessionId === undefined || query.input.sessionId === state.hot.entry?.sessionId
        ? state
        : state.historicalWindows.get(query.input.sessionId);
    if (!window?.hot.entry) {
      continue;
    }
    context.get(sessionKey);
    if (query.type === "session.memory.resetRecall") {
      return resolveSessionResetRecallCutoff(window.events.map((row) => row.event));
    }
    return {
      sessionId: window.hot.entry.sessionId,
      sessionKey,
      stats: readSessionActorMemoryTranscriptStats(window),
      events: window.events.map(({ event }) =>
        query.input.includeMessages ? event : projectSessionEntryRecord(event),
      ),
    };
  }
  return query.type === "session.memory.resetRecall" ? { state: "invalid" } : undefined;
}
