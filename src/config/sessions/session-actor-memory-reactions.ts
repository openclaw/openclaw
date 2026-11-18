import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionActorMemoryReaction } from "./session-actor-memory-collaboration-state.js";
import {
  resolveSessionActorMemoryWindow,
  type SessionActorMemoryState,
} from "./session-actor-memory-state.js";
import type {
  SetSessionReactionParams,
  SessionReactionWrite,
  StoredMessageReactionSummary,
} from "./session-reaction-store.types.js";

function compareRows(left: SessionActorMemoryReaction, right: SessionActorMemoryReaction) {
  return (
    left.createdAt - right.createdAt ||
    Buffer.compare(Buffer.from(left.emoji), Buffer.from(right.emoji)) ||
    Buffer.compare(Buffer.from(left.identityId), Buffer.from(right.identityId))
  );
}
function summarize(rows: SessionActorMemoryReaction[]): StoredMessageReactionSummary[] {
  const summaries = new Map<string, StoredMessageReactionSummary>();
  for (const row of rows) {
    let summary = summaries.get(row.emoji);
    if (!summary) {
      summary = { emoji: row.emoji, count: 0, identities: [] };
      summaries.set(row.emoji, summary);
    }
    summary.count++;
    summary.identities.push({
      id: row.identityId,
      ...(row.identityLabel ? { label: row.identityLabel } : {}),
    });
  }
  return [...summaries.values()];
}
function hasEvent(state: SessionActorMemoryState, sessionId: string, messageId: string) {
  return (
    resolveSessionActorMemoryWindow(state, sessionId)?.events.some(
      ({ event }) =>
        isRecord(event) && typeof event.id === "string" && event.id.trim() === messageId,
    ) ?? false
  );
}
export function pruneSessionActorMemoryReactions(state: SessionActorMemoryState): void {
  const identities = new Map<string, Set<string>>();
  state.collaboration.reactions = state.collaboration.reactions.filter((row) => {
    let ids = identities.get(row.sessionId);
    if (!ids) {
      ids = new Set(
        resolveSessionActorMemoryWindow(state, row.sessionId)?.events.flatMap(({ event }) =>
          isRecord(event) && typeof event.id === "string" && event.id.trim()
            ? [event.id.trim()]
            : [],
        ),
      );
      identities.set(row.sessionId, ids);
    }
    return ids.has(row.messageId);
  });
}
export function readSessionActorMemoryReactions(
  state: SessionActorMemoryState,
  sessionId: string,
): Record<string, StoredMessageReactionSummary[]> {
  const messages = new Map<string, SessionActorMemoryReaction[]>();
  for (const row of state.collaboration.reactions
    .filter((reaction) => reaction.sessionId === sessionId)
    .toSorted(compareRows)) {
    const rows = messages.get(row.messageId) ?? [];
    rows.push(row);
    messages.set(row.messageId, rows);
  }
  return Object.fromEntries([...messages].map(([id, rows]) => [id, summarize(rows)]));
}
export function setSessionActorMemoryReaction(
  state: SessionActorMemoryState,
  params: SetSessionReactionParams,
): SessionReactionWrite {
  const rows = state.collaboration.reactions;
  const selected = rows.filter(
    (row) => row.sessionId === params.expectedSessionId && row.messageId === params.messageId,
  );
  const existing = selected.find(
    (row) => row.emoji === params.emoji && row.identityId === params.identityId,
  );
  let changed = false;
  if (params.remove ? existing : !existing) {
    if (params.remove) {
      state.collaboration.reactions = rows.filter((row) => row !== existing);
      selected.splice(selected.indexOf(existing!), 1);
    } else {
      if (
        rows.filter((row) => row.sessionId === params.expectedSessionId).length >= 5_000 ||
        selected.filter((row) => row.identityId === params.identityId).length >= 20
      ) {
        const error = new Error("reaction limit reached");
        error.name = "SessionReactionLimitError";
        throw error;
      }
      if (!hasEvent(state, params.expectedSessionId, params.messageId)) {
        const error = new Error("unknown message");
        error.name = "SessionReactionMessageMissingError";
        throw error;
      }
      const row = {
        sessionId: params.expectedSessionId,
        messageId: params.messageId,
        emoji: params.emoji,
        identityId: params.identityId,
        identityLabel: params.identityLabel,
        createdAt: Date.now(),
      };
      rows.push(row);
      selected.push(row);
    }
    changed = true;
  }
  selected.sort(compareRows);
  return { reactions: summarize(selected), newestRemainingEmoji: selected.at(-1)?.emoji, changed };
}
