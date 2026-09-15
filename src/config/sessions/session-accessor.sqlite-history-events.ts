import type { TranscriptDisplayPosition } from "../../chat/transcript-display-position.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  resolveHistoryAnchorPageRange,
  resolveTranscriptPageEnd,
  type TranscriptAnchorPageOptions,
  type TranscriptRecentReadLimits,
} from "../../sessions/transcript-anchor-page.js";
import type { TranscriptReadWindowOptions } from "../../sessions/transcript-read-window.js";
import { isVisibleTranscriptRecord } from "../../sessions/transcript-visible-record.js";
import type {
  SessionTranscriptMessageAnchorPage,
  SessionTranscriptMessageEventPage,
} from "./session-accessor.sqlite-active-events.js";
import {
  getActiveTranscriptKysely,
  withCurrentProjectionSnapshot,
  type CurrentTranscriptProjection,
  type SessionTranscriptMessageEvent,
} from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptRawDeltaResult,
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  createTranscriptRawDeltaCursor,
  readTranscriptRawDeltaFromProjection,
} from "./session-accessor.sqlite-delta.js";
import { positionTranscriptDisplayEvents } from "./session-accessor.sqlite-display-position.js";
import {
  isVisibleHistoryNonMessageEventSql,
  parseStoredTranscriptEvent,
  readHistoricalHistoryAnchorPage,
  resolveHistoricalHistoryEventById,
} from "./session-accessor.sqlite-history-interval.js";
import {
  assertHistoryReadWindow,
  captureHistoryReadWindow,
  resolveHistoryMessageSequence,
  resolveVisibleHistoryEventCount,
  resolveVisibleHistoryProjection,
  resolveVisibleHistoryRange,
  type VisibleHistoryBoundary,
  type VisibleHistoryProjection,
} from "./session-accessor.sqlite-history-projection.js";
import {
  assertVisibleMessageRangeJson,
  hasUnindexedVisibleMessages,
  iterateVisibleMessageRange,
  iterateVisibleMessageMetadata,
  readVisibleMessageRange,
  resolveVisibleMessagePositions,
} from "./session-accessor.sqlite-reset-window.js";
import { MAX_VISIBLE_MESSAGE_MAX_MESSAGES } from "./session-accessor.sqlite-visible-cursor.js";

function readBoundaryEvents(
  projection: CurrentTranscriptProjection,
  boundaries: Iterable<VisibleHistoryBoundary>,
): Map<number, TranscriptEvent> {
  const eventSeqs = Array.from(boundaries, (boundary) => boundary.eventSeq);
  const [firstSeq] = eventSeqs;
  const lastSeq = eventSeqs.at(-1);
  if (firstSeq === undefined || lastSeq === undefined) {
    return new Map();
  }
  const db = getActiveTranscriptKysely(projection.database);
  return new Map(
    executeSqliteQuerySync(
      projection.database.db,
      db
        .selectFrom("session_transcript_active_events as active")
        .innerJoin("transcript_event_identities as identity", (join) =>
          join
            .onRef("identity.session_id", "=", "active.session_id")
            .onRef("identity.seq", "=", "active.event_seq"),
        )
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "active.session_id")
            .onRef("event.seq", "=", "active.event_seq"),
        )
        .select(["event.seq", "event.event_json"])
        .where("active.session_id", "=", projection.resolved.sessionId)
        .where((eb) =>
          isVisibleHistoryNonMessageEventSql(
            eb.ref("identity.event_type"),
            eb.ref("event.event_json"),
            eb.ref("active.event_seq"),
            eb.ref("event.seq"),
          ),
        )
        .where("identity.seq", ">=", firstSeq)
        .where("identity.seq", "<=", lastSeq),
    ).rows.map((row) => [row.seq, parseStoredTranscriptEvent(row.event_json)]),
  );
}

function readVisibleHistoryRange(
  projection: CurrentTranscriptProjection,
  start: number,
  endExclusive: number,
  history = resolveVisibleHistoryProjection(projection),
): SessionTranscriptMessageEvent[] {
  const range = resolveVisibleHistoryRange(history, start, endExclusive);
  if (range.boundedEnd <= range.boundedStart) {
    return [];
  }
  const messages = readVisibleMessageRange(projection, range.messageStart, range.messageEnd);
  const boundaryEvents = readBoundaryEvents(projection, range.boundaries.values());
  return positionTranscriptDisplayEvents(
    projection,
    history.displaySource,
    Array.from(mergeVisibleHistoryEvents(range, messages, boundaryEvents)),
  );
}

function* mergeVisibleHistoryEvents(
  range: ReturnType<typeof resolveVisibleHistoryRange>,
  messages: Iterable<SessionTranscriptMessageEvent>,
  boundaryEvents: Map<number, TranscriptEvent>,
): IterableIterator<SessionTranscriptMessageEvent> {
  const iterator = messages[Symbol.iterator]();
  try {
    for (
      let displayPosition = range.boundedStart;
      displayPosition < range.boundedEnd;
      displayPosition += 1
    ) {
      const boundary = range.boundaries.get(displayPosition);
      if (boundary) {
        const event = boundaryEvents.get(boundary.eventSeq);
        if (event) {
          yield { event, eventSeq: boundary.eventSeq, seq: displayPosition + 1 };
        }
        continue;
      }
      const message = iterator.next();
      if (!message.done) {
        yield { ...message.value, seq: displayPosition + 1 };
      }
    }
  } finally {
    iterator.return?.();
  }
}

function resolveRecentHistoryStart(
  projection: CurrentTranscriptProjection,
  start: number,
  endExclusive: number,
  history: VisibleHistoryProjection,
  maxBytes: number,
  maxMessages: number,
  allowOversizedFirst = true,
): number {
  const { boundedEnd, boundedStart, boundaries, messageEnd, messageStart } =
    resolveVisibleHistoryRange(history, start, endExclusive);
  // No result can include more than maxMessages events, so older metadata would
  // only add synchronous work before the backward scan stops.
  const metadataStart = Math.max(messageStart, messageEnd - maxMessages);
  const metadata = iterateVisibleMessageMetadata(projection, metadataStart, messageEnd, "desc");
  let nextMetadata: ReturnType<typeof metadata.next> | undefined;
  let messageIndex = messageEnd - 1;
  let selectedStart = boundedEnd;
  let selectedCount = 0;
  let bytes = 0;
  try {
    for (
      let displayPosition = boundedEnd - 1;
      displayPosition >= boundedStart;
      displayPosition -= 1
    ) {
      if (selectedCount >= maxMessages) {
        break;
      }
      const boundary = boundaries.get(displayPosition);
      let serializedBytes = boundary?.serializedBytes;
      if (!boundary) {
        nextMetadata ??= metadata.next();
        if (!nextMetadata.done && nextMetadata.value.logicalPosition === messageIndex) {
          serializedBytes = nextMetadata.value.serialized_bytes;
          nextMetadata = undefined;
        }
        messageIndex -= 1;
      }
      if (serializedBytes === undefined) {
        continue;
      }
      if ((!allowOversizedFirst || selectedCount > 0) && bytes + serializedBytes > maxBytes) {
        break;
      }
      selectedStart = displayPosition;
      selectedCount += 1;
      bytes += serializedBytes;
    }
  } finally {
    metadata.return?.();
  }
  return selectedStart;
}

type SessionTranscriptMessageById = SessionTranscriptMessageEvent & { serializedBytes?: number };
export type SessionTranscriptMessageByIdOptions =
  | { currentOnly?: false; maxBytes?: never }
  | { currentOnly: true; maxBytes: number };

function readVisibleMessageById(
  projection: CurrentTranscriptProjection,
  eventId: string,
  history: VisibleHistoryProjection,
  maxBytes?: number,
): SessionTranscriptMessageById | undefined {
  const db = getActiveTranscriptKysely(projection.database);
  let query = db
    .selectFrom("transcript_event_identities as identity")
    .innerJoin("session_transcript_active_events as active", (join) =>
      join
        .onRef("active.session_id", "=", "identity.session_id")
        .onRef("active.event_seq", "=", "identity.seq"),
    )
    .innerJoin("transcript_events as event", (join) =>
      join
        .onRef("event.session_id", "=", "active.session_id")
        .onRef("event.seq", "=", "active.event_seq"),
    )
    .select(["active.event_seq", "active.message_position", "event.event_json"])
    .where("identity.session_id", "=", projection.resolved.sessionId)
    .where("identity.event_id", "=", eventId)
    .where("active.message_position", "is not", null);
  if (maxBytes !== undefined) {
    query = query.where((eb) =>
      eb(eb.fn<number>("octet_length", ["event.event_json"]), "<=", maxBytes),
    );
  }
  const row = executeSqliteQueryTakeFirstSync(projection.database.db, query);
  if (!row || row.message_position === null) {
    return undefined;
  }
  const seq = resolveHistoryMessageSequence(
    resolveVisibleMessagePositions(projection),
    history,
    row.message_position,
  );
  return seq === undefined
    ? undefined
    : {
        event: parseStoredTranscriptEvent(row.event_json),
        eventSeq: row.event_seq,
        seq,
        ...(maxBytes !== undefined
          ? { serializedBytes: Buffer.byteLength(row.event_json, "utf8") }
          : {}),
      };
}

function resolveHistoryEventById(
  projection: CurrentTranscriptProjection,
  eventId: string,
  history = resolveVisibleHistoryProjection(projection),
  maxBytes?: number,
): SessionTranscriptMessageById | undefined {
  const boundary = history.boundaries.find((candidate) => candidate.eventId === eventId);
  if (boundary) {
    if (maxBytes !== undefined && boundary.serializedBytes > maxBytes) {
      return undefined;
    }
    const event = readBoundaryEvents(projection, [boundary]).get(boundary.eventSeq);
    return event
      ? {
          event,
          eventSeq: boundary.eventSeq,
          seq: boundary.displayPosition + 1,
          ...(maxBytes !== undefined ? { serializedBytes: boundary.serializedBytes } : {}),
        }
      : undefined;
  }
  return readVisibleMessageById(projection, eventId, history, maxBytes);
}

type SessionTranscriptRawDeltaPage = Extract<SessionTranscriptRawDeltaResult, { kind: "page" }>;

export type SessionTranscriptDisplayDeltaResult =
  | (Omit<SessionTranscriptRawDeltaPage, "events"> & {
      activeLeafEntryId: string | null;
      events: Array<
        SessionTranscriptRawDeltaPage["events"][number] & {
          messageSeq?: number;
          displayPosition?: TranscriptDisplayPosition;
        }
      >;
    })
  | Exclude<SessionTranscriptRawDeltaResult, { kind: "page" }>;

/** Raw cursor progress carries the same reset-relative ordinals as pages and live messages. */
export function readTranscriptDisplayDelta(
  scope: SessionTranscriptReadScope,
  limits: SessionTranscriptRawDeltaLimits = {},
): SessionTranscriptDisplayDeltaResult {
  const readLimits = { ...limits };
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const result = readTranscriptRawDeltaFromProjection(projection, readLimits);
    if (result.kind !== "page") {
      return result;
    }
    if (result.events.length === 0) {
      return { ...result, activeLeafEntryId: projection.state.leafEventId };
    }
    const history = resolveVisibleHistoryProjection(projection);
    const visible = resolveVisibleMessagePositions(projection);
    const firstSeq = result.events[0]?.seq;
    const lastSeq = result.events.at(-1)?.seq;
    const db = getActiveTranscriptKysely(projection.database);
    const sequences = new Map(
      firstSeq === undefined || lastSeq === undefined
        ? []
        : executeSqliteQuerySync(
            projection.database.db,
            db
              .selectFrom("session_transcript_active_events")
              .select(["event_seq", "message_position"])
              .where("session_id", "=", projection.resolved.sessionId)
              .where("event_seq", ">=", firstSeq)
              .where("event_seq", "<=", lastSeq)
              .where("message_position", "is not", null),
          ).rows.map((row) => [
            row.event_seq,
            row.message_position === null
              ? undefined
              : resolveHistoryMessageSequence(visible, history, row.message_position),
          ]),
    );
    if (firstSeq !== undefined && lastSeq !== undefined) {
      for (const boundary of history.boundaries) {
        if (boundary.eventSeq >= firstSeq && boundary.eventSeq <= lastSeq) {
          sequences.set(boundary.eventSeq, boundary.displayPosition + 1);
        }
      }
    }
    const events = positionTranscriptDisplayEvents(
      projection,
      history.displaySource,
      result.events.map((row) => {
        const messageSeq = sequences.get(row.seq);
        return { ...row, eventSeq: row.seq, ...(messageSeq === undefined ? {} : { messageSeq }) };
      }),
    );
    return { ...result, activeLeafEntryId: projection.state.leafEventId, events };
  });
}

export function readSessionTranscriptHistoryEvents(
  scope: SessionTranscriptReadScope,
  options: { readOnly?: boolean } = {},
): SessionTranscriptMessageEvent[] {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => {
      const history = resolveVisibleHistoryProjection(projection);
      return readVisibleHistoryRange(projection, 0, history.total, history);
    },
    options,
  );
}

function readRecentHistoryInSnapshot(
  projection: CurrentTranscriptProjection,
  history: VisibleHistoryProjection,
  options: TranscriptRecentReadLimits & TranscriptReadWindowOptions,
): SessionTranscriptMessageEventPage {
  assertHistoryReadWindow(projection, history, options.expectedReadWindow);
  const generation = projection.generation;
  const deltaCursor = generation
    ? createTranscriptRawDeltaCursor({
        agentId: projection.resolved.agentId,
        generation,
        lastSeq: projection.state.indexedSeq,
        sessionId: projection.resolved.sessionId,
      })
    : undefined;
  const maxMessages = Math.min(
    MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
    Math.max(0, Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 0)),
  );
  const maxLines = Math.max(
    0,
    Math.floor(Number.isFinite(options.maxLines) ? options.maxLines : 0),
  );
  if (maxMessages === 0 || maxLines === 0) {
    return {
      activeLeafEntryId: projection.state.leafEventId,
      ...(deltaCursor ? { deltaCursor } : {}),
      events: [],
      displaySource: history.displaySource,
      totalMessages: history.total,
      ...(options.captureReadWindow ? { readWindow: captureHistoryReadWindow(history, []) } : {}),
    };
  }
  const maxBytes = Math.max(
    1024,
    Math.floor(Number.isFinite(options.maxBytes) ? options.maxBytes : 8 * 1024 * 1024),
  );
  const selectedStart = resolveRecentHistoryStart(
    projection,
    Math.max(0, history.total - maxLines),
    history.total,
    history,
    maxBytes,
    maxMessages,
  );
  const events = readVisibleHistoryRange(projection, selectedStart, history.total, history);
  return {
    activeLeafEntryId: projection.state.leafEventId,
    ...(deltaCursor ? { deltaCursor } : {}),
    events,
    displaySource: history.displaySource,
    totalMessages: history.total,
    ...(options.captureReadWindow ? { readWindow: captureHistoryReadWindow(history, events) } : {}),
  };
}

export function readRecentSessionTranscriptHistoryEvents(
  scope: SessionTranscriptReadScope,
  options: TranscriptRecentReadLimits & TranscriptReadWindowOptions & { readOnly?: boolean },
): SessionTranscriptMessageEventPage {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) =>
      readRecentHistoryInSnapshot(projection, resolveVisibleHistoryProjection(projection), options),
    options,
  );
}

export function readSessionTranscriptHistoryEventPage(
  scope: SessionTranscriptReadScope,
  options: {
    maxMessages: number;
    offset: number;
    beforeSeq?: number;
    maxBytes?: number;
    readOnly?: boolean;
    recentAtHead?: TranscriptRecentReadLimits;
  } & TranscriptReadWindowOptions,
): SessionTranscriptMessageEventPage {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => {
      const history = resolveVisibleHistoryProjection(projection);
      const endExclusive = resolveTranscriptPageEnd(history.total, options);
      if (options.recentAtHead && endExclusive === history.total) {
        return readRecentHistoryInSnapshot(projection, history, {
          ...options.recentAtHead,
          captureReadWindow: options.captureReadWindow,
          expectedReadWindow: options.expectedReadWindow,
        });
      }
      assertHistoryReadWindow(projection, history, options.expectedReadWindow);
      const maxMessages = Math.max(
        0,
        Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 0),
      );
      const requestedStart = Math.max(0, endExclusive - maxMessages);
      const boundedStart =
        options.maxBytes === undefined
          ? requestedStart
          : resolveRecentHistoryStart(
              projection,
              requestedStart,
              endExclusive,
              history,
              Math.max(
                1024,
                Math.floor(Number.isFinite(options.maxBytes) ? options.maxBytes : 1024 * 1024),
              ),
              maxMessages,
              false,
            );
      // A single oversized event must not defeat the hard limit or trap pagination.
      // Skip its source position explicitly; callers disclose the omission to readers.
      const omittedOversized = maxMessages > 0 && endExclusive > 0 && boundedStart === endExclusive;
      const consumedStart = omittedOversized ? endExclusive - 1 : boundedStart;
      const events = readVisibleHistoryRange(projection, boundedStart, endExclusive, history);
      return {
        activeLeafEntryId: projection.state.leafEventId,
        events,
        displaySource: history.displaySource,
        totalMessages: history.total,
        ...(options.maxBytes !== undefined && maxMessages > 0 && consumedStart > 0
          ? {
              olderOffset:
                resolveTranscriptPageEnd(history.total, { beforeSeq: options.beforeSeq }) -
                consumedStart,
            }
          : {}),
        ...(omittedOversized ? { omittedOversized: true } : {}),
        ...(options.captureReadWindow
          ? { readWindow: captureHistoryReadWindow(history, events) }
          : {}),
      };
    },
    options,
  );
}

export function readSessionTranscriptHistoryEventCount(scope: SessionTranscriptReadScope): number {
  return withCurrentProjectionSnapshot(scope, resolveVisibleHistoryEventCount);
}

export function readSessionTranscriptHistoryEventById(
  scope: SessionTranscriptReadScope,
  eventId: string,
  options: SessionTranscriptMessageByIdOptions = {},
): SessionTranscriptMessageById | undefined {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const history = resolveVisibleHistoryProjection(projection);
    const event: SessionTranscriptMessageById | undefined =
      resolveHistoryEventById(projection, eventId, history, options.maxBytes) ??
      (options.currentOnly ? undefined : resolveHistoricalHistoryEventById(projection, eventId));
    if (!event) {
      return undefined;
    }
    const positioned = positionTranscriptDisplayEvents(projection, history.displaySource, [
      event,
    ])[0];
    return positioned && event.serializedBytes !== undefined
      ? { ...positioned, serializedBytes: event.serializedBytes }
      : positioned;
  });
}

/** Select ID candidates and projected-history presence from one validated snapshot. */
export function readSessionTranscriptHistoryEventLookup(
  scope: SessionTranscriptReadScope,
  eventId: string,
): { events: SessionTranscriptMessageEvent[]; hasDisplayMessages: boolean } {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const history = resolveVisibleHistoryProjection(projection);
    const range = resolveVisibleHistoryRange(history, 0, history.total);
    if (
      !eventId.trim() ||
      hasUnindexedVisibleMessages(projection, range.messageStart, range.messageEnd)
    ) {
      // Unindexed stored rows can retain message.__openclaw.id during projection.
      // Let the full reader select those candidates; the caller matches projected IDs.
      const events = readVisibleHistoryRange(projection, 0, history.total, history);
      return {
        events,
        hasDisplayMessages: events.some((row) => isVisibleTranscriptRecord(row.event)),
      };
    }
    assertVisibleMessageRangeJson(projection, range.messageStart, range.messageEnd);
    const boundaryEvents = readBoundaryEvents(projection, range.boundaries.values());
    let first: SessionTranscriptMessageEvent | undefined;
    let hasDisplayMessages = false;
    for (const event of mergeVisibleHistoryEvents(
      range,
      iterateVisibleMessageRange(projection, range.messageStart, range.messageEnd),
      boundaryEvents,
    )) {
      first ??= event;
      if (isVisibleTranscriptRecord(event.event)) {
        hasDisplayMessages = true;
        break;
      }
    }
    const event = resolveHistoryEventById(projection, eventId.trim(), history);
    // Nonempty history validates the current-turn admission even when the requested
    // ID is absent. Keep that fence while positioning only the selected/first row.
    const positioned = positionTranscriptDisplayEvents(
      projection,
      history.displaySource,
      event ? [event] : first ? [first] : [],
    );
    return {
      events: event ? positioned : [],
      hasDisplayMessages,
    };
  });
}

export function readSessionTranscriptHistoryAnchorPage(
  scope: SessionTranscriptReadScope,
  options: TranscriptAnchorPageOptions & { readOnly?: boolean },
): SessionTranscriptMessageAnchorPage {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => {
      const history = resolveVisibleHistoryProjection(projection);
      assertHistoryReadWindow(projection, history, options.expectedReadWindow);
      const anchor = resolveHistoryEventById(projection, options.messageId, history);
      if (!anchor) {
        // Explicit anchors reopen the closed reset interval that still contains the
        // active-path row. Unanchored history and current-display lookup stay
        // latest-reset-relative; missing or off-path IDs stay not-found.
        return (
          readHistoricalHistoryAnchorPage(projection, history.displaySource, options) ?? {
            events: [],
            found: false,
            hasOverreadContext: false,
            offset: 0,
            displaySource: history.displaySource,
            totalMessages: history.total,
          }
        );
      }
      const range = resolveHistoryAnchorPageRange(history.total, anchor.seq - 1, options);
      return {
        events: readVisibleHistoryRange(projection, range.readStart, range.endExclusive, history),
        found: true,
        hasOverreadContext: range.hasOverreadContext,
        offset: range.offset,
        displaySource: history.displaySource,
        totalMessages: history.total,
      };
    },
    options,
  );
}
