import { sql, type Expression, type RawBuilder, type SqlBool } from "kysely";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../../agents/internal-runtime-context.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { SessionTranscriptMessageAnchorPage } from "./session-accessor.sqlite-active-events.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
  type SessionTranscriptMessageEvent,
} from "./session-accessor.sqlite-active-projection.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { positionTranscriptDisplayEvents } from "./session-accessor.sqlite-display-position.js";
import {
  resolveClosedResetInterval,
  type ClosedResetInterval,
} from "./session-accessor.sqlite-reset-window.js";

/** Select display slots without loading custom content or details into history metadata. */
export function isVisibleHistoryNonMessageEventSql(
  type: Expression<string | null>,
  event: Expression<string | null>,
  activeEventSeq: Expression<number>,
  eventSeq: Expression<number>,
): RawBuilder<SqlBool> {
  const activeEvent = /* kysely-allow-raw: JSON parsing requires the joined active-row key. */ sql<
    string | null
  >`CASE WHEN ${activeEventSeq} = ${eventSeq} THEN ${event} END`;
  // Match isVisibleTranscriptRecord; CASE avoids parsing unrelated marker payloads.
  return /* kysely-allow-raw: query-time display selection leaves canonical events and message indexes unchanged. */ sql<SqlBool>`(${type} IN ('compaction', 'reset', 'custom_message') AND CASE
    WHEN ${type} IN ('compaction', 'reset') THEN 1
    WHEN ${type} = 'custom_message' THEN
      json_type(${activeEvent}, '$.display') = 'true'
      AND json_extract(${activeEvent}, '$.customType') IS NOT ${OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE}
    ELSE 0 END)`;
}

export function parseStoredTranscriptEvent(eventJson: string): TranscriptEvent {
  // SAFETY: The active projection indexes serialized TranscriptEvent rows.
  return JSON.parse(eventJson) as TranscriptEvent;
}

function selectHistoricalDisplayEvents(
  projection: CurrentTranscriptProjection,
  interval: ClosedResetInterval,
) {
  return getActiveTranscriptKysely(projection.database)
    .selectFrom("session_transcript_active_events as active")
    .innerJoin(
      // Without statistics, the covering event-type index can scan the session for every row.
      getActiveTranscriptKysely(projection.database)
        .selectFrom("transcript_event_identities")
        .select(["session_id", "seq", "event_type"])
        .modifyEnd(
          /* kysely-allow-raw: pin the canonical sequence lookup to avoid quadratic cold-history joins. */ sql`INDEXED BY idx_agent_transcript_event_identity_sequence`,
        )
        .as("identity"),
      (join) =>
        join
          .onRef("identity.session_id", "=", "active.session_id")
          .onRef("identity.seq", "=", "active.event_seq"),
    )
    .innerJoin("transcript_events as event", (join) =>
      join
        .onRef("event.session_id", "=", "active.session_id")
        .onRef("event.seq", "=", "active.event_seq"),
    )
    .where("active.session_id", "=", projection.resolved.sessionId)
    .where("active.active_position", ">", interval.startExclusiveActivePosition)
    .where("active.active_position", "<=", interval.endInclusiveActivePosition)
    .where((eb) =>
      eb.or([
        eb("active.message_position", "is not", null),
        isVisibleHistoryNonMessageEventSql(
          eb.ref("identity.event_type"),
          eb.ref("event.event_json"),
          eb.ref("active.event_seq"),
          eb.ref("event.seq"),
        ),
      ]),
    );
}

function readDisplayableActiveEventById(projection: CurrentTranscriptProjection, eventId: string) {
  const db = getActiveTranscriptKysely(projection.database);
  return executeSqliteQueryTakeFirstSync(
    projection.database.db,
    db
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
      .select([
        "active.event_seq",
        "active.active_position",
        "active.message_position",
        "identity.event_type",
        "event.event_json",
      ])
      .where("identity.session_id", "=", projection.resolved.sessionId)
      .where("identity.event_id", "=", eventId)
      .where((eb) =>
        eb.or([
          eb("active.message_position", "is not", null),
          isVisibleHistoryNonMessageEventSql(
            eb.ref("identity.event_type"),
            eb.ref("event.event_json"),
            eb.ref("active.event_seq"),
            eb.ref("event.seq"),
          ),
        ]),
      ),
  );
}

function countHistoricalDisplayEvents(
  projection: CurrentTranscriptProjection,
  interval: ClosedResetInterval,
  beforeActivePosition: number,
): number {
  const query = selectHistoricalDisplayEvents(projection, interval)
    .select((eb) => eb.fn.countAll<number>().as("event_count"))
    .where("active.active_position", "<", beforeActivePosition);
  const row = executeSqliteQueryTakeFirstSync(projection.database.db, query);
  return row?.event_count ?? 0;
}

function readHistoricalDisplayEventRange(
  projection: CurrentTranscriptProjection,
  displaySource: string | undefined,
  interval: ClosedResetInterval,
  start: number,
  count: number,
  anchor: { activePosition: number; displayPosition: number },
): SessionTranscriptMessageEvent[] {
  if (count <= 0) {
    return [];
  }
  const query = selectHistoricalDisplayEvents(projection, interval).select([
    "active.event_seq",
    "event.event_json",
  ]);
  const olderCount = anchor.displayPosition - start;
  // The anchor already identifies the physical position; visit only its selected neighbors.
  const older = executeSqliteQuerySync(
    projection.database.db,
    query
      .where("active.active_position", "<", anchor.activePosition)
      .orderBy("active.active_position", "desc")
      .limit(olderCount),
  ).rows;
  const newer = executeSqliteQuerySync(
    projection.database.db,
    query
      .where("active.active_position", ">=", anchor.activePosition)
      .orderBy("active.active_position", "asc")
      .limit(count - olderCount),
  ).rows;
  return positionTranscriptDisplayEvents(
    projection,
    displaySource,
    [...older.toReversed(), ...newer].map((row, index) => ({
      event: parseStoredTranscriptEvent(row.event_json),
      eventSeq: row.event_seq,
      seq: start + index + 1,
    })),
  );
}

function resolveClosedResetIntervalForDisplayable(
  projection: CurrentTranscriptProjection,
  row: { active_position: number; event_type: string | null },
): ClosedResetInterval | undefined {
  if (typeof row.event_type !== "string") {
    return undefined;
  }
  return resolveClosedResetInterval(projection, {
    activePosition: row.active_position,
    eventType: row.event_type,
  });
}

export function resolveHistoricalHistoryEventById(
  projection: CurrentTranscriptProjection,
  eventId: string,
): SessionTranscriptMessageEvent | undefined {
  const row = readDisplayableActiveEventById(projection, eventId);
  if (!row) {
    return undefined;
  }
  const interval = resolveClosedResetIntervalForDisplayable(projection, row);
  if (!interval) {
    return undefined;
  }
  return {
    event: parseStoredTranscriptEvent(row.event_json),
    eventSeq: row.event_seq,
    seq: countHistoricalDisplayEvents(projection, interval, row.active_position) + 1,
  };
}

export function readHistoricalHistoryAnchorPage(
  projection: CurrentTranscriptProjection,
  displaySource: string | undefined,
  options: { maxMessages: number; messageId: string },
): SessionTranscriptMessageAnchorPage | undefined {
  const row = readDisplayableActiveEventById(projection, options.messageId);
  if (!row) {
    return undefined;
  }
  const interval = resolveClosedResetIntervalForDisplayable(projection, row);
  if (!interval) {
    return undefined;
  }
  const counts = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    selectHistoricalDisplayEvents(projection, interval).select((eb) => [
      eb.fn.countAll<number>().as("total"),
      eb.fn
        .countAll<number>()
        .filterWhere("active.active_position", "<", row.active_position)
        .as("before_anchor"),
    ]),
  );
  const total = counts?.total ?? 0;
  const anchorPosition = counts?.before_anchor ?? 0;
  const pageSize = Math.max(
    1,
    Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 1),
  );
  const newerMessages = Math.floor(pageSize / 2);
  const olderMessages = pageSize - newerMessages - 1;
  const latestStart = Math.max(0, total - pageSize);
  const start = Math.min(Math.max(0, anchorPosition - olderMessages), latestStart);
  const endExclusive = Math.min(total, start + pageSize);
  const readStart = Math.max(0, start - 1);
  return {
    events: readHistoricalDisplayEventRange(
      projection,
      displaySource,
      interval,
      readStart,
      endExclusive - readStart,
      { activePosition: row.active_position, displayPosition: anchorPosition },
    ),
    found: true,
    hasOverreadContext: readStart < start,
    offset: total - endExclusive,
    displaySource,
    totalMessages: total,
  };
}
