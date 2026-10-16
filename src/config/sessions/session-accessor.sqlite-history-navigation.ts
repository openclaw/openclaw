import { toUSVString } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql, type Expression, type RawBuilder, type SqlBool } from "kysely";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type {
  UnindexedActiveTranscriptNavigation,
  UnindexedTranscriptNavigation,
} from "./session-accessor.sqlite-history-navigation.types.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import {
  transcriptEventNavigationSql,
  transcriptEventResetNavigationSql,
} from "./transcript-payload.js";

function parseNavigation(eventJson: string): Record<string, unknown> | undefined {
  const parsed: unknown = JSON.parse(eventJson);
  if (!isRecord(parsed)) {
    return undefined;
  }
  // SQLite-overdepth rows reach JSON.parse whole; retain only navigation afterward.
  const {
    type,
    id,
    parentId,
    targetId,
    appendParentId,
    appendMode,
    firstKeptEntryId,
    customType,
    display,
  } = parsed;
  return {
    type,
    id,
    parentId,
    targetId,
    appendParentId,
    appendMode,
    firstKeptEntryId,
    customType,
    display,
  };
}

function navigationCandidatesSql(
  identitySeq: Expression<number | null>,
  event: Expression<string>,
  candidate: { key: "id"; eventIds: readonly string[] },
): RawBuilder<SqlBool> {
  const match =
    candidate.eventIds.length > 32
      ? /* kysely-allow-raw: keep the member guard; callers filter large sets without a quadratic scan. */ sql<SqlBool>`1`
      : candidate.eventIds.length === 1
        ? /* kysely-allow-raw: bound instr narrows IDs before exact JavaScript matching. */ sql<SqlBool>`instr(member.value, ${candidate.eventIds[0]}) > 0`
        : /* kysely-allow-raw: nested json_each matches bound ID sets without row hydration. */ sql<SqlBool>`EXISTS (SELECT 1 FROM json_each(${JSON.stringify(candidate.eventIds)}) AS requested
        WHERE instr(member.value, requested.value) > 0)`;
  // Admit any duplicate root member; JavaScript applies last-key and full trim semantics.
  // Invalid and SQLite-overdepth rows still reach the existing JSON.parse fallback.
  // Fence JSON behind the anti-join so indexed payloads are never parsed just to reject them.
  return /* kysely-allow-raw: decoded members only narrow unindexed candidates; JavaScript owns exact matching. */ sql<SqlBool>`CASE WHEN ${identitySeq} IS NOT NULL THEN 0
    WHEN json_valid(${event}) THEN EXISTS (
      SELECT 1 FROM json_each(${event}) AS member
      WHERE member.key = ${candidate.key} AND member.type = 'text' AND ${match}
    ) ELSE 1 END`;
}

function canFilterEventIds(eventIds: readonly string[] | undefined): eventIds is readonly string[] {
  return (
    eventIds !== undefined && eventIds.every((id) => toUSVString(id) === id && !id.includes("\0"))
  );
}

function unindexedNavigationQuery(
  projection: CurrentTranscriptProjection,
  eventIds: readonly string[] | undefined,
) {
  return getActiveTranscriptKysely(projection.database)
    .selectFrom("transcript_events as event")
    .leftJoin("transcript_event_identities as identity", (join) =>
      join
        .onRef("identity.session_id", "=", "event.session_id")
        .onRef("identity.seq", "=", "event.seq"),
    )
    .select([
      "event.seq as event_seq",
      transcriptEventResetNavigationSql(projection.database.db, "event").as("event_json"),
      /* kysely-allow-raw: preserve original event byte costs while reading navigation only. */
      sql<number>`${transcriptEventReadBytesSql("event")} + 1`.as("serialized_bytes"),
    ])
    .where("event.session_id", "=", projection.resolved.sessionId)
    .where("identity.seq", "is", null)
    .$if(canFilterEventIds(eventIds), (filtered) =>
      filtered.where((eb) =>
        navigationCandidatesSql(
          eb.ref("identity.seq"),
          transcriptEventNavigationSql(projection.database.db, "event"),
          {
            key: "id",
            eventIds: eventIds!,
          },
        ),
      ),
    );
}

function* navigationRows<Row extends { event_json: string }>(rows: Iterable<Row>) {
  for (const { event_json, ...row } of rows) {
    const event = parseNavigation(event_json);
    if (event) {
      yield { ...row, event };
    }
  }
}

/** Exact legacy handoffs retained raw rows without creating identity ownership. */
export function* iterateUnindexedTranscriptNavigation(
  projection: CurrentTranscriptProjection,
  options: {
    afterRawSeq?: number;
    maxRawSeq?: number;
    eventIds?: readonly string[];
    controlsOnly?: boolean;
  } = {},
): IterableIterator<UnindexedTranscriptNavigation> {
  if (!projection.hasUnindexedPrefix || options.eventIds?.length === 0) {
    return;
  }
  const query = unindexedNavigationQuery(projection, options.eventIds)
    .$if(options.controlsOnly === true, (filtered) =>
      filtered.where((eb) =>
        eb.or([
          eb("event.navigation_valid", "=", 0),
          eb("event.navigation_last_type", "in", ["reset", "compaction", "custom_message"]),
        ]),
      ),
    )
    .where("event.seq", "<=", options.maxRawSeq ?? projection.state.indexedSeq)
    .$if(options.afterRawSeq !== undefined, (filtered) =>
      filtered.where("event.seq", ">", options.afterRawSeq!),
    )
    .orderBy("event.seq", "asc");
  yield* navigationRows(iterateSqliteQuerySync(projection.database.db, query));
}

export function* iterateUnindexedActiveTranscriptNavigation(
  projection: CurrentTranscriptProjection,
  options: {
    beforeActivePosition?: number;
    maxRawSeq?: number;
    first?: boolean;
    eventIds?: readonly string[];
  } = {},
): IterableIterator<UnindexedActiveTranscriptNavigation> {
  if (!projection.hasUnindexedPrefix || options.eventIds?.length === 0) {
    return;
  }
  const query = unindexedNavigationQuery(projection, options.eventIds)
    .innerJoin("session_transcript_active_events as active", (join) =>
      join
        .onRef("event.session_id", "=", "active.session_id")
        .onRef("event.seq", "=", "active.event_seq"),
    )
    .select(["active.active_position", "active.message_position"])
    .where("active.event_seq", "<=", options.maxRawSeq ?? projection.state.indexedSeq)
    .$if(options.beforeActivePosition !== undefined, (filtered) =>
      filtered.where("active.active_position", "<", options.beforeActivePosition!),
    )
    .orderBy("active.active_position", options.first ? "asc" : "desc");
  yield* navigationRows(iterateSqliteQuerySync(projection.database.db, query));
}

/** Resolve display navigation without assigning identity or idempotency ownership. */
export function findUnindexedActiveTranscriptEntry(
  projection: CurrentTranscriptProjection,
  eventId: string,
): UnindexedActiveTranscriptNavigation | undefined {
  for (const row of iterateUnindexedActiveTranscriptNavigation(projection, {
    eventIds: [eventId],
  })) {
    if (typeof row.event.id === "string" && row.event.id.trim() === eventId) {
      return row;
    }
  }
  return undefined;
}
