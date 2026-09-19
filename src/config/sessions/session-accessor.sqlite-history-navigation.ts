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
import { projectResetBoundaryNavigationSql } from "./session-model-context-projection.js";

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
  event: Expression<string>,
  candidate: { key: "id"; eventIds: readonly string[] } | { key: "type" },
): RawBuilder<SqlBool> {
  const match =
    candidate.key === "type"
      ? /* kysely-allow-raw: fixed discriminators filter decoded JSON members. */ sql<SqlBool>`member.value IN ('reset', 'compaction', 'custom_message')`
      : candidate.eventIds.length > 32
        ? /* kysely-allow-raw: keep the member guard; callers filter large sets without a quadratic scan. */ sql<SqlBool>`1`
        : candidate.eventIds.length === 1
          ? /* kysely-allow-raw: bound instr narrows IDs before exact JavaScript matching. */ sql<SqlBool>`instr(member.value, ${candidate.eventIds[0]}) > 0`
          : /* kysely-allow-raw: nested json_each matches bound ID sets without row hydration. */ sql<SqlBool>`EXISTS (SELECT 1 FROM json_each(${JSON.stringify(candidate.eventIds)}) AS requested
        WHERE instr(member.value, requested.value) > 0)`;
  // Admit any duplicate root member; JavaScript applies last-key and full trim semantics.
  // Invalid and SQLite-overdepth rows still reach the existing JSON.parse fallback.
  return /* kysely-allow-raw: decoded members only narrow candidates; JavaScript owns exact matching. */ sql<SqlBool>`CASE WHEN json_valid(${event}) THEN EXISTS (
      SELECT 1 FROM json_each(${event}) AS member
      WHERE member.key = ${candidate.key} AND member.type = 'text' AND ${match}
    ) ELSE 1 END`;
}

function canFilterEventIds(eventIds: readonly string[] | undefined): eventIds is readonly string[] {
  return (
    eventIds !== undefined && eventIds.every((id) => toUSVString(id) === id && !id.includes("\0"))
  );
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
  const db = getActiveTranscriptKysely(projection.database);
  const query = db
    .selectFrom("transcript_events as event")
    .leftJoin("transcript_event_identities as identity", (join) =>
      join
        .onRef("identity.session_id", "=", "event.session_id")
        .onRef("identity.seq", "=", "event.seq"),
    )
    .select((eb) => [
      "event.seq as event_seq",
      projectResetBoundaryNavigationSql(eb.ref("event.event_json")).as("event_json"),
      /* kysely-allow-raw: preserve original event byte costs while reading navigation only. */
      sql<number>`OCTET_LENGTH(event.event_json) + 1`.as("serialized_bytes"),
    ])
    .where("event.session_id", "=", projection.resolved.sessionId)
    .where("identity.seq", "is", null)
    .$if(canFilterEventIds(options.eventIds), (filtered) =>
      filtered.where((eb) =>
        navigationCandidatesSql(eb.ref("event.event_json"), {
          key: "id",
          eventIds: options.eventIds!,
        }),
      ),
    )
    .$if(options.controlsOnly === true, (filtered) =>
      filtered.where((eb) => navigationCandidatesSql(eb.ref("event.event_json"), { key: "type" })),
    )
    .where("event.seq", "<=", options.maxRawSeq ?? projection.state.indexedSeq)
    .$if(options.afterRawSeq !== undefined, (filtered) =>
      filtered.where("event.seq", ">", options.afterRawSeq!),
    )
    .orderBy("event.seq", "asc");
  for (const row of iterateSqliteQuerySync(projection.database.db, query)) {
    const event = parseNavigation(row.event_json);
    if (event) {
      yield { event_seq: row.event_seq, serialized_bytes: row.serialized_bytes, event };
    }
  }
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
  const db = getActiveTranscriptKysely(projection.database);
  const query = db
    .selectFrom("session_transcript_active_events as active")
    .innerJoin("transcript_events as event", (join) =>
      join
        .onRef("event.session_id", "=", "active.session_id")
        .onRef("event.seq", "=", "active.event_seq"),
    )
    .leftJoin("transcript_event_identities as identity", (join) =>
      join
        .onRef("identity.session_id", "=", "active.session_id")
        .onRef("identity.seq", "=", "active.event_seq"),
    )
    .select((eb) => [
      "active.event_seq",
      "active.active_position",
      "active.message_position",
      projectResetBoundaryNavigationSql(eb.ref("event.event_json")).as("event_json"),
      /* kysely-allow-raw: a bounded lookup admits the original payload size before hydration. */
      sql<number>`OCTET_LENGTH(event.event_json) + 1`.as("serialized_bytes"),
    ])
    .where("active.session_id", "=", projection.resolved.sessionId)
    .where("identity.seq", "is", null)
    .$if(canFilterEventIds(options.eventIds), (filtered) =>
      filtered.where((eb) =>
        navigationCandidatesSql(eb.ref("event.event_json"), {
          key: "id",
          eventIds: options.eventIds!,
        }),
      ),
    )
    .where("active.event_seq", "<=", options.maxRawSeq ?? projection.state.indexedSeq)
    .$if(options.beforeActivePosition !== undefined, (filtered) =>
      filtered.where("active.active_position", "<", options.beforeActivePosition!),
    )
    .orderBy("active.active_position", options.first ? "asc" : "desc");
  for (const row of iterateSqliteQuerySync(projection.database.db, query)) {
    const event = parseNavigation(row.event_json);
    if (event) {
      yield {
        event_seq: row.event_seq,
        active_position: row.active_position,
        message_position: row.message_position,
        serialized_bytes: row.serialized_bytes,
        event,
      };
    }
  }
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
