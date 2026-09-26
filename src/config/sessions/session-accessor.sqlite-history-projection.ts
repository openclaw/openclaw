import type { DatabaseSync } from "node:sqlite";
import { sql, type RawBuilder } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  prepareSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { TranscriptReadWindow } from "../../sessions/transcript-read-window.js";
import { readTranscriptDisplaySource } from "./session-accessor.sqlite-display-position.js";
import {
  isVisibleHistoryNonMessageEvent,
  isVisibleHistoryNonMessageEventSql,
} from "./session-accessor.sqlite-history-interval.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
  type SessionTranscriptMessageEvent,
} from "./session-accessor.sqlite-projection-read.js";
import {
  readUnindexedHistoryControls,
  resolveTranscriptBoundaryWindow,
  resolveVisibleMessagePositions,
} from "./session-accessor.sqlite-reset-window.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { transcriptEventNavigationSql } from "./transcript-payload.js";

export type VisibleHistoryBoundary = {
  displayPosition: number;
  eventId: string;
  eventSeq: number;
  messagePosition: number;
  serializedBytes: number;
};

export type VisibleHistoryProjection = {
  boundaries: VisibleHistoryBoundary[];
  displaySource?: string;
  latestResetRawSeq: number | null;
  total: number;
};

type HistoryBoundaryQueryShape = "markers" | "branch" | "reset";

function resolveHistoryBoundaryQueryShape(
  projection: CurrentTranscriptProjection,
  boundaryActivePosition: number | undefined,
): HistoryBoundaryQueryShape {
  if (boundaryActivePosition !== undefined) {
    return "reset";
  }
  if (projection.state.activeEventCount >= projection.state.indexedSeq) {
    return "markers";
  }
  // A branch can retain most messages but few markers, or discard a marker-heavy
  // past. Probe only up to the active-row count using the covering type index.
  const db = getActiveTranscriptKysely(projection.database);
  const markerBudget = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    db
      .selectFrom(
        db
          .selectFrom("transcript_event_identities")
          .select(["session_id", "event_type", "seq"])
          .modifyEnd(
            /* kysely-allow-raw: count candidates without reading identity or transcript payloads. */
            sql`INDEXED BY idx_agent_transcript_event_sequence`,
          )
          .as("identity"),
      )
      .select("seq")
      .where("session_id", "=", projection.resolved.sessionId)
      .where("event_type", "in", ["compaction", "reset", "custom_message"])
      .limit(1)
      .offset(Math.max(0, projection.state.activeEventCount - 1)),
  );
  return markerBudget ? "branch" : "markers";
}

function selectVisibleHistoryBoundaries(
  database: CurrentTranscriptProjection["database"],
  sessionId: string | RawBuilder<string>,
  shape: HistoryBoundaryQueryShape,
  boundaryActivePosition: number | RawBuilder<number> | undefined,
) {
  const db = getActiveTranscriptKysely(database);
  const identity = db
    .selectFrom("transcript_event_identities")
    .select(["session_id", "event_id", "seq", "event_type"])
    .modifyEnd(
      // Whole-session reads select marker types; branches and resets join exact active rows.
      /* kysely-allow-raw: preserve selective canonical index access after ANALYZE. */
      shape === "markers"
        ? sql`INDEXED BY idx_agent_transcript_event_sequence`
        : sql`INDEXED BY idx_agent_transcript_event_identity_sequence`,
    )
    .as("identity");
  // Pin the selected driving set even without ANALYZE: branches must not scan
  // discarded markers, and sparse marker reads must not scan every active message.
  const query =
    shape === "markers"
      ? db.selectFrom(identity).crossJoin("session_transcript_active_events as active")
      : db.selectFrom("session_transcript_active_events as active").crossJoin(identity);
  return query
    .crossJoin("transcript_events as event")
    .whereRef("identity.session_id", "=", "active.session_id")
    .whereRef("identity.seq", "=", "active.event_seq")
    .whereRef("event.session_id", "=", "active.session_id")
    .whereRef("event.seq", "=", "active.event_seq")
    .where("active.session_id", "=", sessionId)
    .where((eb) => {
      const type = eb.ref("identity.event_type");
      const event = transcriptEventNavigationSql("event");
      const activeEventSeq = eb.ref("active.event_seq");
      const eventSeq = eb.ref("event.seq");
      if (boundaryActivePosition === undefined) {
        return isVisibleHistoryNonMessageEventSql(type, event, activeEventSeq, eventSeq);
      }
      const inWindow = eb("active.active_position", ">=", boundaryActivePosition);
      // Fence the JSON argument while leaving type/range predicates visible to the planner.
      return eb.and([
        inWindow,
        isVisibleHistoryNonMessageEventSql(
          type,
          eb.case().when(inWindow).then(event).else(null).end(),
          activeEventSeq,
          eventSeq,
        ),
      ]);
    });
}

type HistoryCountParameters = { sessionId: string; boundaryActivePosition: number };

const historyCountReaders = new WeakMap<
  DatabaseSync,
  Map<
    HistoryBoundaryQueryShape,
    (params: HistoryCountParameters) => { event_count: number } | undefined
  >
>();

function getHistoryCountReader(
  database: CurrentTranscriptProjection["database"],
  shape: HistoryBoundaryQueryShape,
) {
  let readers = historyCountReaders.get(database.db);
  if (!readers) {
    readers = new Map();
    historyCountReaders.set(database.db, readers);
  }
  let read = readers.get(shape);
  if (!read) {
    // Retain compilation only; each snapshot supplies its current session and reset bound.
    read = prepareSqliteQueryTakeFirstSync<HistoryCountParameters, { event_count: number }>(
      database.db,
      (parameter) =>
        selectVisibleHistoryBoundaries(
          database,
          parameter((params) => params.sessionId),
          shape,
          shape === "reset" ? parameter((params) => params.boundaryActivePosition) : undefined,
        ).select((eb) => eb.fn.countAll<number>().as("event_count")),
    );
    readers.set(shape, read);
  }
  return read;
}

export function resolveVisibleHistoryEventCount(projection: CurrentTranscriptProjection): number {
  if (projection.state.activeEventCount === projection.state.activeMessageCount) {
    return projection.state.activeMessageCount;
  }
  const visibleMessages = resolveVisibleMessagePositions(projection);
  const shape = resolveHistoryBoundaryQueryShape(
    projection,
    visibleMessages.boundaryActivePosition,
  );
  const readCount = getHistoryCountReader(projection.database, shape);
  const count = readCount({
    sessionId: projection.resolved.sessionId,
    boundaryActivePosition: visibleMessages.boundaryActivePosition ?? 0,
  });
  const unindexed = readUnindexedHistoryControls(projection).filter(
    (row) =>
      isVisibleHistoryNonMessageEvent(row.event) &&
      row.active_position >= (visibleMessages.boundaryActivePosition ?? 0),
  );
  return visibleMessages.total + (count?.event_count ?? 0) + unindexed.length;
}

export function resolveVisibleHistoryProjection(
  projection: CurrentTranscriptProjection,
): VisibleHistoryProjection {
  const displaySource = readTranscriptDisplaySource(projection);
  if (projection.state.activeEventCount === projection.state.activeMessageCount) {
    return {
      boundaries: [],
      displaySource,
      latestResetRawSeq: null,
      total: projection.state.activeMessageCount,
    };
  }
  const visibleMessages = resolveVisibleMessagePositions(projection);
  const latestResetRawSeq = resolveTranscriptBoundaryWindow(projection)?.boundarySeq ?? null;
  const db = getActiveTranscriptKysely(projection.database);
  const rows = executeSqliteQuerySync(
    projection.database.db,
    selectVisibleHistoryBoundaries(
      projection.database,
      projection.resolved.sessionId,
      resolveHistoryBoundaryQueryShape(projection, visibleMessages.boundaryActivePosition),
      visibleMessages.boundaryActivePosition,
    )
      .leftJoin("session_transcript_active_events as following", (join) =>
        join
          .onRef("following.session_id", "=", "active.session_id")
          .on((eb) => eb("following.active_position", "=", eb("active.active_position", "+", 1))),
      )
      .select([
        "active.active_position",
        "following.message_position as following_message_position",
        "identity.event_id",
        "identity.seq",
        /* kysely-allow-raw: history byte caps include each event's JSONL newline. */
        sql<number>`${transcriptEventReadBytesSql("event")} + 1`.as("serialized_bytes"),
      ])
      .orderBy("active.active_position", "asc"),
  ).rows;
  for (const control of readUnindexedHistoryControls(projection)) {
    if (
      !isVisibleHistoryNonMessageEvent(control.event) ||
      control.active_position < (visibleMessages.boundaryActivePosition ?? 0)
    ) {
      continue;
    }
    rows.push({
      active_position: control.active_position,
      following_message_position: control.following_message_position,
      event_id: typeof control.event.id === "string" ? control.event.id.trim() : "",
      seq: control.event_seq,
      serialized_bytes: control.serialized_bytes,
    });
  }
  if (projection.hasUnindexedPrefix) {
    rows.sort((left, right) => left.active_position - right.active_position);
  }
  const readNextMessage = prepareSqliteQuerySync<
    number,
    { active_position: number; message_position: number | null }
  >(projection.database.db, (parameter) =>
    db
      .selectFrom("session_transcript_active_events")
      .select(["active_position", "message_position"])
      .where("session_id", "=", projection.resolved.sessionId)
      .where(
        "active_position",
        ">",
        parameter((position) => position),
      )
      .where("message_position", "is not", null)
      .orderBy("active_position", "asc")
      .limit(1),
  );
  let nextMessage: { active_position: number; message_position: number | null } | undefined;
  let searched = false;
  const boundaries = rows.map((row, index): VisibleHistoryBoundary => {
    let nextMessagePosition = row.following_message_position;
    if (nextMessagePosition === null) {
      // Ordered markers share the next message until its position is crossed.
      // Scan each intervening gap once, including an exhausted trailing gap.
      if (!searched || (nextMessage && nextMessage.active_position < row.active_position)) {
        nextMessage = readNextMessage(row.active_position).rows[0];
        searched = true;
      }
      nextMessagePosition = nextMessage?.message_position ?? projection.state.activeMessageCount;
    }
    // Kept messages precede the latest reset; later markers share its logical window.
    // Rebase raw positions so discarded messages cannot shift those markers.
    const messagePosition =
      visibleMessages.kept.length + Math.max(0, nextMessagePosition - visibleMessages.postStart);
    return {
      displayPosition: messagePosition + index,
      eventId: row.event_id,
      eventSeq: row.seq,
      messagePosition,
      serializedBytes: row.serialized_bytes,
    };
  });
  return {
    boundaries,
    displaySource,
    latestResetRawSeq,
    total: visibleMessages.total + boundaries.length,
  };
}

export function resolveVisibleHistoryRange(
  history: VisibleHistoryProjection,
  start: number,
  endExclusive: number,
) {
  const boundedStart = Math.min(Math.max(0, start), history.total);
  const boundedEnd = Math.min(Math.max(boundedStart, endExclusive), history.total);
  // Projected display positions are strictly increasing, including adjacent markers.
  let boundariesBefore = 0;
  let end = history.boundaries.length;
  while (boundariesBefore < end) {
    const middle = Math.floor((boundariesBefore + end) / 2);
    if (history.boundaries[middle]!.displayPosition < boundedStart) {
      boundariesBefore = middle + 1;
    } else {
      end = middle;
    }
  }
  const boundaries = new Map<number, VisibleHistoryBoundary>();
  for (let index = boundariesBefore; index < history.boundaries.length; index += 1) {
    const boundary = history.boundaries[index]!;
    if (!(boundary.displayPosition < boundedEnd)) {
      break;
    }
    boundaries.set(boundary.displayPosition, boundary);
  }
  const messageStart = boundedStart - boundariesBefore;
  const messageEnd = messageStart + boundedEnd - boundedStart - boundaries.size;
  return { boundedEnd, boundedStart, boundaries, messageEnd, messageStart };
}

export function resolveHistoryMessageSequence(
  visible: ReturnType<typeof resolveVisibleMessagePositions>,
  history: VisibleHistoryProjection,
  messagePosition: number,
): number | undefined {
  const logicalPosition =
    messagePosition >= visible.postStart
      ? visible.kept.length + messagePosition - visible.postStart
      : visible.kept.indexOf(messagePosition);
  if (logicalPosition < 0) {
    return undefined;
  }
  // Boundaries follow active order; equal positions all precede this message.
  let precedingBoundaries = 0;
  let end = history.boundaries.length;
  while (precedingBoundaries < end) {
    const middle = Math.floor((precedingBoundaries + end) / 2);
    // The half-open search range stays inside the dense boundary projection.
    if (history.boundaries[middle]!.messagePosition <= logicalPosition) {
      precedingBoundaries = middle + 1;
    } else {
      end = middle;
    }
  }
  return logicalPosition + 1 + precedingBoundaries;
}

export function captureHistoryReadWindow(
  history: VisibleHistoryProjection,
  events: readonly SessionTranscriptMessageEvent[],
): TranscriptReadWindow {
  const anchor = events.at(-1);
  return {
    source: history.displaySource,
    latestResetRawSeq: history.latestResetRawSeq,
    ...(anchor ? { anchor: { rawSeq: anchor.eventSeq, seq: anchor.seq } } : {}),
  };
}

export function resolveHistoryReadWindowChange(
  projection: CurrentTranscriptProjection,
  history: VisibleHistoryProjection,
  expected: TranscriptReadWindow | undefined,
): { anchorSeq?: number } | undefined {
  if (!expected) {
    return undefined;
  }
  if (expected.source !== history.displaySource) {
    return {};
  }
  const anchor = expected.anchor;
  if (!anchor) {
    return expected.latestResetRawSeq === history.latestResetRawSeq ? undefined : {};
  }
  const row = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    getActiveTranscriptKysely(projection.database)
      .selectFrom("session_transcript_active_events")
      .select("message_position")
      .where("session_id", "=", projection.resolved.sessionId)
      .where("event_seq", "=", anchor.rawSeq),
  );
  const position = row?.message_position;
  const boundary =
    position === null
      ? history.boundaries.find((entry) => entry.eventSeq === anchor.rawSeq)
      : undefined;
  const seq =
    position === undefined
      ? undefined
      : position === null
        ? boundary && boundary.displayPosition + 1
        : resolveHistoryMessageSequence(
            resolveVisibleMessagePositions(projection),
            history,
            position,
          );
  return seq === anchor.seq && expected.latestResetRawSeq === history.latestResetRawSeq
    ? undefined
    : { anchorSeq: seq };
}
