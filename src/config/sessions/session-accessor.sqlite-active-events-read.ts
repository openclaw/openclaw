import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  getActiveTranscriptKysely,
  parseActiveTranscriptMessageRow,
  readSnapshotEventRows,
  type CurrentTranscriptProjection,
  type SessionTranscriptBoundedMessageTailOptions,
  type SessionTranscriptBoundedMessageTailPage,
} from "./session-accessor.sqlite-projection-read.js";
import {
  hasOversizedVisibleMessages,
  iterateVisibleMessageMetadata,
  resolveVisibleMessagePositions,
  resolveTranscriptBoundaryWindow,
} from "./session-accessor.sqlite-reset-window.js";
import { MAX_VISIBLE_MESSAGE_MAX_MESSAGES } from "./session-accessor.sqlite-visible-cursor.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

/** Runs repeatable newest-first visits synchronously inside one context-tail snapshot. */
export function withRecentSessionTranscriptActiveEventsInSnapshot<T>(
  projection: CurrentTranscriptProjection,
  maxEvents: number,
  read: (visit: (visitor: (event: TranscriptEvent) => void) => void) => T,
): T {
  const limit = resolveIntegerOption(maxEvents, 0, { min: 0 });
  const db = getActiveTranscriptKysely(projection.database);
  const query = db
    .selectFrom("session_transcript_active_events as active")
    .innerJoin("transcript_events as event", (join) =>
      join
        .onRef("event.session_id", "=", "active.session_id")
        .onRef("event.seq", "=", "active.event_seq"),
    )
    .select(transcriptEventJsonSql(projection.database.db, "event").as("event_json"))
    .where("active.session_id", "=", projection.resolved.sessionId)
    .where("active.context_eligible", "=", 1)
    .orderBy("active.active_position", "desc")
    .limit(limit);
  let active = true;
  try {
    return read((visitor) => {
      if (!active) {
        throw new Error("Transcript visitor used outside its read snapshot");
      }
      if (limit === 0) {
        return;
      }
      let parseError: Error | undefined;
      // Finish stepping before reporting JSON errors: SQL failures take precedence,
      // followed by the oldest malformed row in the selected tail.
      for (const row of iterateSqliteQuerySync(projection.database.db, query)) {
        let event: TranscriptEvent;
        try {
          // SAFETY: Transcript writers persist TranscriptEvent objects; parse failures are handled here.
          event = JSON.parse(row.event_json) as TranscriptEvent;
        } catch (error) {
          parseError = toErrorObject(error, "Transcript event JSON parsing failed");
          continue;
        }
        visitor(event);
      }
      if (parseError !== undefined) {
        throw parseError;
      }
    });
  } finally {
    active = false;
  }
}

export function readSessionTranscriptBoundedMessageTailPageFromProjection(
  projection: CurrentTranscriptProjection,
  options: SessionTranscriptBoundedMessageTailOptions,
): SessionTranscriptBoundedMessageTailPage {
  const visible = resolveVisibleMessagePositions(projection);
  const snapshot = {
    boundarySeq: resolveTranscriptBoundaryWindow(projection)?.boundarySeq,
    generation: projection.generation,
    indexedSeq: projection.state.indexedSeq,
  };
  const totalMessages = visible.total;
  const offset = resolveIntegerOption(options.offset, 0, { min: 0, max: totalMessages });
  const maxMessages = resolveIntegerOption(options.maxMessages, 0, {
    min: 0,
    max: MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
  });
  const maxBytes = resolveIntegerOption(options.maxBytes, 0, { min: 0 });
  const endExclusive = Math.max(0, totalMessages - offset);
  const start = Math.max(0, endExclusive - maxMessages);
  const scannedMessages = endExclusive - start;
  const oversized = options.oversizedMessageCheck;
  const checked = oversized
    ? {
        hasOversizedMessages: hasOversizedVisibleMessages(
          projection,
          oversized.includeEarlier ? 0 : start,
          endExclusive,
          maxBytes,
          oversized.roles,
        ),
      }
    : {};
  if (scannedMessages === 0 || maxBytes === 0) {
    return {
      ...checked,
      activeLeafEntryId: projection.state.leafEventId,
      events: [],
      newestContiguousEventCount: 0,
      scannedMessages,
      serializedBytes: 0,
      snapshot,
      totalMessages,
    };
  }
  const metadata = Array.from(iterateVisibleMessageMetadata(projection, start, endExclusive));
  if (metadata.length !== scannedMessages) {
    throw new Error("Active transcript bounded message page is incomplete");
  }
  const selected: typeof metadata = [];
  let newestContiguousEventCount: number | undefined;
  let serializedBytes = 0;
  for (let index = metadata.length - 1; index >= 0; index -= 1) {
    const row = metadata[index]!;
    if (serializedBytes + row.serialized_bytes > maxBytes) {
      newestContiguousEventCount ??= selected.length;
      continue;
    }
    selected.push(row);
    serializedBytes += row.serialized_bytes;
  }
  const payloads = new Map(
    selected.length === 0
      ? []
      : readSnapshotEventRows(
          projection,
          selected.map((row) => row.event_seq),
        ).map((row) => [row.seq, row]),
  );
  const events = selected
    .toSorted((left, right) => left.message_position - right.message_position)
    .flatMap((row) => {
      const payload = payloads.get(row.event_seq);
      return payload === undefined ? [] : [parseActiveTranscriptMessageRow({ ...row, ...payload })];
    });
  return {
    ...checked,
    activeLeafEntryId: projection.state.leafEventId,
    events,
    newestContiguousEventCount: newestContiguousEventCount ?? selected.length,
    scannedMessages,
    serializedBytes,
    snapshot,
    totalMessages,
  };
}
