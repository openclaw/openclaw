import { toUSVString } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql, type Expression, type RawBuilder, type SqlBool } from "kysely";
import {
  jsonNativeFieldsValid,
  jsonObjectFieldsForScan,
  jsonObjectStringEntries,
  jsonScannedValue,
} from "../../infra/database-engine/json-values.js";
import { engineStringPosition } from "../../infra/database-engine/scalar.js";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { scanJsonObjectFields } from "../../state/json-predicate-fields.js";
import type {
  UnindexedActiveTranscriptNavigation,
  UnindexedTranscriptNavigation,
} from "./session-accessor.sqlite-history-navigation.types.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { transcriptEventNavigationSql, transcriptPredicateSql } from "./transcript-payload.js";

const navigationFields = {
  type: true,
  id: true,
  parentId: true,
  targetId: true,
  appendParentId: true,
  appendMode: true,
  firstKeptEntryId: true,
  customType: true,
  display: true,
} as const;

function parseNavigation(eventJson: string): Record<string, unknown> | undefined {
  const selected = Object.keys(navigationFields);
  const fields = scanJsonObjectFields(eventJson, selected);
  if (!fields.valid || fields.maximumDepth > 1000 || !eventJson.trimStart().startsWith("{")) {
    const parsed: unknown = JSON.parse(eventJson);
    if (!isRecord(parsed)) {
      return undefined;
    }
    // Invalid and SQLite-overdepth rows retain the original JSON.parse fallback.
    return Object.fromEntries(selected.map((key) => [key, parsed[key]]));
  }
  const navigation: Record<string, unknown> = {};
  for (const key of selected) {
    const token = fields.last.get(key);
    // Native projection decoded scalar strings, while nested values stayed JSON.
    const value: unknown =
      token?.kind === "string"
        ? jsonScannedValue(token)
        : token
          ? JSON.parse(token.text)
          : undefined;
    navigation[key] = value;
  }
  return navigation;
}

function navigationCandidatesSql(
  database: EngineConnection,
  identitySeq: Expression<number | null>,
  event: Expression<string>,
  navigationValid: Expression<number>,
  eventIds: readonly string[],
): RawBuilder<SqlBool> {
  const member =
    /* kysely-allow-raw: fixed member alias in the candidate enumeration below. */ sql.ref<string>(
      "member.value",
    );
  const match =
    eventIds.length > 32
      ? /* kysely-allow-raw: keep the member guard; callers filter large sets without a quadratic scan. */ sql<SqlBool>`true`
      : /* kysely-allow-raw: bound substrings only narrow candidates before exact JavaScript matching. */ sql<SqlBool>`(${sql.join(
          eventIds.map((id) => sql`${engineStringPosition(database, member, sql.val(id))} > 0`),
          sql` OR `,
        )})`;
  // Admit any duplicate root member; JavaScript applies last-key and full trim semantics.
  // Invalid and SQLite-overdepth rows still reach the existing JSON.parse fallback.
  // Fence JSON behind the anti-join so indexed payloads are never parsed just to reject them.
  return /* kysely-allow-raw: decoded members only narrow unindexed candidates; JavaScript owns exact matching. */ sql<SqlBool>`CASE WHEN ${identitySeq} IS NOT NULL THEN false
    WHEN ${navigationValid} = 1 AND ${jsonNativeFieldsValid(database, event)} THEN EXISTS (
      SELECT 1 FROM ${jsonObjectStringEntries(database, event)} AS member
      WHERE member.key = ${"id"} AND ${match}
    ) ELSE true END`;
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
  const event = transcriptEventNavigationSql(projection.database.db, "event");
  return getActiveTranscriptKysely(projection.database)
    .selectFrom("transcript_events as event")
    .leftJoin("transcript_event_identities as identity", (join) =>
      join
        .onRef("identity.session_id", "=", "event.session_id")
        .onRef("identity.seq", "=", "event.seq"),
    )
    .select([
      "event.seq as event_seq",
      /* kysely-allow-raw: stored validity preserves the raw overdepth/invalid parser fallback. */
      sql<string>`CASE WHEN event.navigation_valid = 1 THEN ${jsonObjectFieldsForScan(
        projection.database.db,
        event,
        navigationFields,
      )} ELSE ${event} END`.as("event_json"),
      /* kysely-allow-raw: preserve original event byte costs while reading navigation only. */
      sql<number>`${transcriptEventReadBytesSql("event")} + 1`.as("serialized_bytes"),
    ])
    .where("event.session_id", "=", projection.resolved.sessionId)
    .where("identity.seq", "is", null)
    .$if(canFilterEventIds(eventIds), (filtered) =>
      filtered.where((eb) =>
        navigationCandidatesSql(
          projection.database.db,
          eb.ref("identity.seq"),
          event,
          eb.ref("event.navigation_valid"),
          eventIds!,
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
          eb(transcriptPredicateSql(projection.database.db, "navigation_valid", "event"), "=", 0),
          eb(
            transcriptPredicateSql(projection.database.db, "navigation_last_type", "event"),
            "in",
            ["reset", "compaction", "custom_message"],
          ),
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
