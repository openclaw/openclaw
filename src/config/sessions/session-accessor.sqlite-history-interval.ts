import { sql, type Expression, type RawBuilder, type SqlBool } from "kysely";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../../agents/internal-runtime-context.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  resolveHistoryAnchorPageRange,
  type TranscriptAnchorPageOptions,
} from "../../sessions/transcript-anchor-page.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { positionTranscriptDisplayEvents } from "./session-accessor.sqlite-display-position.js";
import { findUnindexedActiveTranscriptEntry } from "./session-accessor.sqlite-history-navigation.js";
import {
  getActiveTranscriptKysely,
  type SessionTranscriptMessageAnchorPage,
  type CurrentTranscriptProjection,
  type SessionTranscriptMessageEvent,
} from "./session-accessor.sqlite-projection-read.js";
import {
  readUnindexedHistoryControls,
  resolveClosedResetInterval,
  type ClosedResetInterval,
} from "./session-accessor.sqlite-reset-window.js";
import { isVisibleHistoryNonMessageEvent } from "./session-history-visibility.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { transcriptEventJsonSql, transcriptEventNavigationSql } from "./transcript-payload.js";

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
  const active = getActiveTranscriptKysely(projection.database).selectFrom(
    "session_transcript_active_events as active",
  );
  const identity =
    // Without statistics, the covering event-type index can scan the session for every row.
    getActiveTranscriptKysely(projection.database)
      .selectFrom("transcript_event_identities")
      .select(["session_id", "seq", "event_type"])
      .modifyEnd(
        /* kysely-allow-raw: pin the canonical sequence lookup to avoid quadratic cold-history joins. */ sql`INDEXED BY idx_agent_transcript_event_identity_sequence`,
      )
      .as("identity");
  const withIdentity = projection.hasUnindexedPrefix
    ? active.leftJoin(identity, (join) =>
        join
          .onRef("identity.session_id", "=", "active.session_id")
          .onRef("identity.seq", "=", "active.event_seq"),
      )
    : active.innerJoin(identity, (join) =>
        join
          .onRef("identity.session_id", "=", "active.session_id")
          .onRef("identity.seq", "=", "active.event_seq"),
      );
  const unindexedControls = readUnindexedHistoryControls(projection)
    .filter(
      (row) =>
        isVisibleHistoryNonMessageEvent(row.event) &&
        row.active_position > interval.startExclusiveActivePosition &&
        row.active_position <= interval.endInclusiveActivePosition,
    )
    .map((row) => row.event_seq);
  return withIdentity
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
          transcriptEventNavigationSql("event"),
          eb.ref("active.event_seq"),
          eb.ref("event.seq"),
        ),
        ...(unindexedControls.length > 0
          ? [
              eb(
                "active.event_seq",
                "in",
                /* kysely-allow-raw: one bounded binding carries recovered control sequences. */
                sql<number>`(SELECT value FROM json_each(${JSON.stringify(unindexedControls)}))`,
              ),
            ]
          : []),
      ]),
    );
}

function selectDisplayableActiveEventById(
  projection: CurrentTranscriptProjection,
  eventId: string,
) {
  const db = getActiveTranscriptKysely(projection.database);
  return db
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
    ])
    .where("identity.session_id", "=", projection.resolved.sessionId)
    .where("identity.event_id", "=", eventId)
    .where((eb) =>
      eb.or([
        eb("active.message_position", "is not", null),
        isVisibleHistoryNonMessageEventSql(
          eb.ref("identity.event_type"),
          transcriptEventNavigationSql("event"),
          eb.ref("active.event_seq"),
          eb.ref("event.seq"),
        ),
      ]),
    );
}

export function readDisplayableActiveEventById(
  projection: CurrentTranscriptProjection,
  eventId: string,
  maxBytes?: number,
) {
  const db = getActiveTranscriptKysely(projection.database);
  const indexed = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    selectDisplayableActiveEventById(projection, eventId).select((eb) =>
      maxBytes === undefined
        ? transcriptEventJsonSql(projection.database.db, "event").as("event_json")
        : eb
            .case()
            .when(eb(transcriptEventReadBytesSql("event"), "<=", maxBytes))
            .then(transcriptEventJsonSql(projection.database.db, "event"))
            .else(null)
            .end()
            .as("event_json"),
    ),
  );
  if (indexed) {
    return indexed.event_json === null ? undefined : { ...indexed, event_json: indexed.event_json };
  }
  const unindexed = findUnindexedActiveTranscriptEntry(projection, eventId);
  if (
    !unindexed ||
    (unindexed.message_position === null && !isVisibleHistoryNonMessageEvent(unindexed.event)) ||
    (maxBytes !== undefined && unindexed.serialized_bytes - 1 > maxBytes)
  ) {
    return undefined;
  }
  const event = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    db
      .selectFrom("transcript_events")
      .select(transcriptEventJsonSql(projection.database.db).as("event_json"))
      .where("session_id", "=", projection.resolved.sessionId)
      .where("seq", "=", unindexed.event_seq),
  );
  return event
    ? {
        event_seq: unindexed.event_seq,
        active_position: unindexed.active_position,
        message_position: unindexed.message_position,
        event_type: typeof unindexed.event.type === "string" ? unindexed.event.type : null,
        event_json: event.event_json,
      }
    : undefined;
}

export function readDisplayableActiveResetMetadataById(
  projection: CurrentTranscriptProjection,
  eventId: string,
): { active_position: number; event_type: "reset" } | undefined {
  const indexed = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    selectDisplayableActiveEventById(projection, eventId),
  );
  if (indexed) {
    return indexed.event_type === "reset"
      ? { active_position: indexed.active_position, event_type: "reset" }
      : undefined;
  }
  const unindexed = findUnindexedActiveTranscriptEntry(projection, eventId);
  return unindexed?.event.type === "reset"
    ? { active_position: unindexed.active_position, event_type: "reset" }
    : undefined;
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
  maxBytes?: number,
): SessionTranscriptMessageEvent[] {
  if (count <= 0) {
    return [];
  }
  const query = selectHistoricalDisplayEvents(projection, interval).select((eb) => [
    "active.event_seq",
    eb(transcriptEventReadBytesSql("event"), "+", 1).as("serialized_bytes"),
  ]);
  const olderCount = anchor.displayPosition - start;
  // The anchor already identifies the physical position; visit only its selected neighbors.
  const older =
    olderCount === 0
      ? []
      : executeSqliteQuerySync(
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
  const ranged = [...older.toReversed(), ...newer].map((row, index) =>
    Object.assign(row, { displaySeq: start + index + 1 }),
  );
  let selected = ranged;
  if (maxBytes !== undefined) {
    const limit = Math.max(1_024, Math.floor(maxBytes));
    let bytes = 2;
    let selectedStart = ranged.length;
    while (selectedStart > 0) {
      const nextBytes = ranged[selectedStart - 1]!.serialized_bytes;
      if (bytes + nextBytes > limit) {
        break;
      }
      bytes += nextBytes;
      selectedStart--;
    }
    selected = ranged.slice(selectedStart);
  }
  if (selected.length === 0) {
    return [];
  }
  const payloads = executeSqliteQuerySync(
    projection.database.db,
    getActiveTranscriptKysely(projection.database)
      .selectFrom("transcript_events")
      .select(["seq", transcriptEventJsonSql(projection.database.db).as("event_json")])
      .where("session_id", "=", projection.resolved.sessionId)
      .where(
        "seq",
        "in",
        selected.map((row) => row.event_seq),
      ),
  ).rows;
  const payloadBySeq = new Map(payloads.map((row) => [row.seq, row.event_json]));
  return positionTranscriptDisplayEvents(
    projection,
    displaySource,
    selected.flatMap((row) => {
      const eventJson = payloadBySeq.get(row.event_seq);
      return eventJson === undefined
        ? []
        : [
            {
              event: parseStoredTranscriptEvent(eventJson),
              eventSeq: row.event_seq,
              seq: row.displaySeq,
            },
          ];
    }),
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

export function resolveHistoricalHistoryEvent(
  projection: CurrentTranscriptProjection,
  row: NonNullable<ReturnType<typeof readDisplayableActiveEventById>>,
): SessionTranscriptMessageEvent | undefined {
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

export function readHistoricalHistoryPrecedingEvent(
  projection: CurrentTranscriptProjection,
  row: NonNullable<ReturnType<typeof readDisplayableActiveEventById>>,
  event: SessionTranscriptMessageEvent,
): SessionTranscriptMessageEvent | undefined {
  const interval = resolveClosedResetIntervalForDisplayable(projection, row);
  return interval && event.seq > 1
    ? readHistoricalDisplayEventRange(projection, undefined, interval, event.seq - 2, 1, {
        activePosition: row.active_position,
        displayPosition: event.seq - 1,
      })[0]
    : undefined;
}

export function readHistoricalHistoryAnchorPage(
  projection: CurrentTranscriptProjection,
  displaySource: string | undefined,
  row: { active_position: number; event_type: string | null },
  options: TranscriptAnchorPageOptions,
  excludeClosingReset = false,
): SessionTranscriptMessageAnchorPage | undefined {
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
  const anchorPosition = counts?.before_anchor ?? 0;
  const total = excludeClosingReset ? anchorPosition : (counts?.total ?? 0);
  const range = resolveHistoryAnchorPageRange(
    total,
    excludeClosingReset ? total - 1 : anchorPosition,
    options,
  );
  return {
    events: readHistoricalDisplayEventRange(
      projection,
      displaySource,
      interval,
      range.readStart,
      range.endExclusive - range.readStart,
      { activePosition: row.active_position, displayPosition: anchorPosition },
      options.maxBytes,
    ),
    found: true,
    hasOverreadContext: range.hasOverreadContext,
    offset: range.offset,
    displaySource,
    totalMessages: total,
  };
}
