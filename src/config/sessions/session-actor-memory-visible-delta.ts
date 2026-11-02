import {
  createVisibleMessageCursor,
  encodeVisibleMessageCursor,
  hasVisibleResetBoundaryChanged,
  normalizeVisibleDeltaLimits,
  parseVisibleMessageCursor,
  withVisibleResetBoundary,
  type VisibleMessageCursor,
} from "./session-accessor.sqlite-visible-cursor.js";
import type {
  SessionTranscriptVisibleMessageDeltaLimits,
  SessionTranscriptVisibleMessageDeltaResult,
} from "./session-accessor.types.js";
import { createSessionActorMemoryHistoryNavigation } from "./session-actor-memory-history-navigation.js";
import type { SessionActorMemoryHistoryScope } from "./session-actor-memory-history-projection.js";
import type { SessionActorMemoryWindow } from "./session-actor-memory-state.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";

type VisibleDeltaResetReason = Extract<
  SessionTranscriptVisibleMessageDeltaResult,
  { kind: "reset" }
>["reason"];

/**
 * Reads one forward page of visible messages from an incognito window, with the same
 * cursor and reset-window contract as the SQLite delta core. The window is already
 * cut at the current-turn admission, so its latest reset honors the read fence.
 */
export function readSessionActorMemoryVisibleDelta(
  window: SessionActorMemoryWindow,
  scope: SessionActorMemoryHistoryScope,
  limits: SessionTranscriptVisibleMessageDeltaLimits,
): SessionTranscriptVisibleMessageDeltaResult {
  const { maxBytes, maxMessages, start } = normalizeVisibleDeltaLimits(limits);
  const generation = window.hot.transcript.version.generation;
  const sessionId = window.hot.entry?.sessionId;
  if (!generation || !sessionId) {
    return { kind: "missing" };
  }
  const navigation = createSessionActorMemoryHistoryNavigation(window);
  const latestReset =
    navigation.latestResetRawSeq === null
      ? null
      : {
          seq: navigation.latestResetRawSeq,
          ...(navigation.latestResetId !== undefined ? { event_id: navigation.latestResetId } : {}),
        };
  const parsed = limits.cursor === undefined ? undefined : parseVisibleMessageCursor(limits.cursor);
  // Fresh cursors keep the caller's start mode; a reset-window cursor implies it.
  const freshCursor = (): VisibleMessageCursor => {
    const initial = createVisibleMessageCursor({ agentId: scope.agentId, sessionId, generation });
    return start !== "reset-window" && parsed?.resetBoundarySeq === undefined
      ? initial
      : withVisibleResetBoundary(initial, latestReset);
  };
  const reset = (reason: VisibleDeltaResetReason): SessionTranscriptVisibleMessageDeltaResult => ({
    kind: "reset",
    cursor: encodeVisibleMessageCursor(freshCursor()),
    reason,
  });
  const cursor = limits.cursor === undefined ? freshCursor() : parsed;
  if (!cursor) {
    return reset("invalid_cursor");
  }
  if (cursor.agentId !== scope.agentId || cursor.sessionId !== sessionId) {
    return reset("scope_mismatch");
  }
  // A newer same-session reset outranks generation and anchor discontinuities.
  const sameGeneration = cursor.generation === generation;
  const resetChanged =
    cursor.resetBoundarySeq !== undefined &&
    hasVisibleResetBoundaryChanged(cursor, latestReset, sameGeneration);
  if (!sameGeneration) {
    return reset(resetChanged ? "session_reset" : "generation_mismatch");
  }
  // A cursor that returned the admitted entry, or saw a reset after it, was read
  // outside this turn's fence.
  if (
    scope.readFence &&
    (cursor.lastMessagePosition >= scope.readFence.beforeActiveMessagePosition ||
      (cursor.resetBoundarySeq ?? -1) >= scope.readFence.beforeRawSeq)
  ) {
    throw new SessionTranscriptReadFenceError(
      "Transcript read cursor has crossed the current-turn admission fence",
    );
  }
  if (resetChanged) {
    return reset("session_reset");
  }
  const messages = navigation.active.filter((row) => row.messagePosition !== null);
  let anchorActivePosition = -1;
  if (cursor.lastEventSeq >= 0) {
    const anchor = messages.find((row) => row.rawSeq === cursor.lastEventSeq);
    if (!anchor) {
      return reset("anchor_missing");
    }
    if (anchor.messagePosition !== cursor.lastMessagePosition) {
      return reset("anchor_moved");
    }
    anchorActivePosition = anchor.activePosition;
  }
  // A reset-window cursor not yet past the reset row drains the retained tail, then
  // everything after the reset row; other cursors read every later message.
  const boundary = navigation.boundaryActivePosition;
  const unread =
    cursor.resetBoundarySeq !== undefined &&
    boundary !== undefined &&
    anchorActivePosition <= boundary
      ? [...navigation.retainedMessages, ...messages.filter((row) => row.activePosition > boundary)]
      : messages;
  let serializedBytes = 0;
  let hasMore = false;
  let requiredBytes: number | undefined;
  let lastEventSeq = cursor.lastEventSeq;
  let lastMessagePosition = cursor.lastMessagePosition;
  const events: Extract<SessionTranscriptVisibleMessageDeltaResult, { kind: "page" }>["events"] =
    [];
  for (const row of unread) {
    if (row.messagePosition! <= cursor.lastMessagePosition) {
      continue;
    }
    if (events.length >= maxMessages || serializedBytes + row.serializedBytes > maxBytes) {
      hasMore = true;
      if (!events.length) {
        requiredBytes = row.serializedBytes;
      }
      break;
    }
    serializedBytes += row.serializedBytes;
    lastEventSeq = row.rawSeq;
    lastMessagePosition = row.messagePosition!;
    events.push({
      event: row.event,
      eventSeq: row.rawSeq,
      seq: row.messagePosition! + 1,
      parentId: navigation.active[row.activePosition - 1]?.node?.id ?? null,
    });
  }
  return {
    kind: "page",
    cursor: encodeVisibleMessageCursor({ ...cursor, lastEventSeq, lastMessagePosition }),
    events,
    hasMore,
    serializedBytes,
    ...(requiredBytes === undefined ? {} : { requiredBytes }),
  };
}
