import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql, type AliasableExpression } from "kysely";
import {
  jsonNativeFieldsValid,
  jsonPathValue,
  jsonRemovePaths,
  jsonSetPath,
} from "../../infra/database-engine/json-values.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import {
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { scanJsonObjectFields } from "../../state/json-predicate-fields.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import type { SqliteTranscriptStorageRow } from "./session-accessor.sqlite-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readNextTranscriptSeq } from "./session-accessor.sqlite-transcript-state.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import {
  TRANSCRIPT_PAYLOAD_COLUMNS,
  transcriptEventJsonSql,
  transcriptEventNavigationSql,
  transcriptEventWithoutCustomDataBytesSql,
} from "./transcript-payload.js";

/** Admit suffix repairs against their projected bytes without decoding opaque bodies. */
export function transcriptRetainedDataBytesSql(
  database: EngineConnection,
  retainedIds: readonly string[],
) {
  if (retainedIds.length === 0) {
    return transcriptEventReadBytesSql();
  }
  const event = transcriptEventNavigationSql(database);
  return /* kysely-allow-raw: mirror the retained-data projection's SQLite-first member matching. */ sql<number>`CASE WHEN ${jsonNativeFieldsValid(database, event)} THEN
    CASE WHEN ${jsonPathValue(database, event, sql.lit("$.type"))} = 'custom'
      AND ${jsonPathValue(database, event, sql.lit("$.id"))} IN (${sql.join(retainedIds)})
      THEN ${transcriptEventWithoutCustomDataBytesSql(database)} ELSE ${transcriptEventReadBytesSql()} END
    ELSE ${transcriptEventReadBytesSql()} END`;
}

/**
 * Custom data is opaque to topology and indexing; cleanup keeps it in SQLite.
 * Rows native fields cannot decode keep their data here; withoutRetainedCustomData drops it.
 */
export function projectTranscriptRetainedDataSql(
  database: EngineConnection,
  event: AliasableExpression<string>,
  retainedIds: readonly string[],
): AliasableExpression<string> {
  return retainedIds.length === 0
    ? event
    : /* kysely-allow-raw: bound cleanup planning to navigation while retaining opaque custom data in its original row. */ sql<string>`CASE WHEN ${jsonNativeFieldsValid(database, event)} THEN
        CASE WHEN ${jsonPathValue(database, event, sql.lit("$.type"))} = 'custom'
          AND ${jsonPathValue(database, event, sql.lit("$.id"))} IN (${sql.join(retainedIds)})
        THEN ${jsonRemovePaths(database, event, [sql.lit("$.data")])} ELSE ${event} END
      ELSE ${event} END`;
}

/** JavaScript half of projectTranscriptRetainedDataSql for rows native fields cannot decode. */
export function withoutRetainedCustomData(
  eventJson: string,
  retainedIds: readonly string[],
): string {
  if (retainedIds.length === 0) {
    return eventJson;
  }
  const fields = scanJsonObjectFields(eventJson, ["data"]);
  if (!fields.valid || !fields.first.has("data")) {
    return eventJson;
  }
  const event: unknown = JSON.parse(eventJson);
  if (
    !isRecord(event) ||
    event.type !== "custom" ||
    typeof event.id !== "string" ||
    !retainedIds.includes(event.id)
  ) {
    return eventJson;
  }
  const { data: _data, ...projected } = event;
  return JSON.stringify(projected);
}

/** Stage opaque payloads inside the same transaction before their old suffix rows are removed. */
export function stageRetainedTranscriptData(
  database: OpenClawAgentDatabase,
  sessionId: string,
  expectedRows: readonly SqliteTranscriptStorageRow[],
  next: readonly TranscriptEvent[],
  retainedIds: readonly string[],
): { startSeq: number; sources: Map<number, number> } | undefined {
  if (retainedIds.length === 0) {
    return undefined;
  }
  const retained = new Set(retainedIds);
  const originals = new Map(
    expectedRows.flatMap((row) => {
      const event: unknown = JSON.parse(row.eventJson);
      return isRecord(event) &&
        event.type === "custom" &&
        typeof event.id === "string" &&
        retained.has(event.id)
        ? [[event.id, { row, event }] as const]
        : [];
    }),
  );
  const copies = next.flatMap((event, index) => {
    if (
      !isRecord(event) ||
      event.type !== "custom" ||
      typeof event.id !== "string" ||
      !retained.has(event.id)
    ) {
      return [];
    }
    const original = originals.get(event.id);
    if (!original) {
      throw new Error("Retained transcript data has no original suffix row");
    }
    const { parentId: _oldParent, ...before } = original.event;
    const { parentId, ...after } = event;
    if (
      Object.hasOwn(before, "data") ||
      Object.hasOwn(after, "data") ||
      !isDeepStrictEqual(before, after) ||
      (parentId !== null && typeof parentId !== "string")
    ) {
      throw new Error("Retained transcript data permits only parent repair");
    }
    return [{ index, sourceSeq: original.row.seq, parentId }];
  });
  if (copies.length === 0) {
    return undefined;
  }
  // Staging uses otherwise vacant sequence positions, never another table or persistent format.
  // All rows are removed before COMMIT; rollback also restores the original suffix atomically.
  const startSeq = readNextTranscriptSeq(database, sessionId) + next.length;
  const sources = new Map<number, number>();
  for (const [offset, copy] of copies.entries()) {
    const stagedSeq = startSeq + offset;
    copyRetainedTranscriptPayload(database, sessionId, copy.sourceSeq, stagedSeq, copy.parentId);
    sources.set(copy.index, stagedSeq);
  }
  return { startSeq, sources };
}

/** Copy a transaction-owned payload without materializing it in JavaScript. */
export function copyRetainedTranscriptPayload(
  database: OpenClawAgentDatabase,
  sessionId: string,
  sourceSeq: number,
  destinationSeq: number,
  parentId?: string | null,
): void {
  const db = getSessionKysely(database.db);
  // Parent repair of a row native fields cannot decode happens in JavaScript.
  const exceptionalJson =
    parentId === undefined
      ? undefined
      : executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("transcript_events")
            .select(
              /* kysely-allow-raw: only rows JSONB rejects are materialized in JavaScript. */
              sql<
                string | null
              >`CASE WHEN ${jsonNativeFieldsValid(database.db, transcriptEventJsonSql(database.db))}
                THEN NULL ELSE ${transcriptEventJsonSql(database.db)} END`.as("event_json"),
            )
            .where("session_id", "=", sessionId)
            .where("seq", "=", sourceSeq),
        )?.event_json;
  const copied = withSqliteDatabaseWriteScope(
    database.db,
    [sqliteSessionIdWriteScope(sessionId)],
    () =>
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("transcript_events")
          .columns(TRANSCRIPT_PAYLOAD_COLUMNS)
          .expression(
            db
              .selectFrom("transcript_events")
              .select((eb) => {
                const eventJson: AliasableExpression<string | null> =
                  parentId === undefined
                    ? eb.ref("event_json")
                    : typeof exceptionalJson === "string"
                      ? /* kysely-allow-raw: bound JavaScript-repaired JSON text. */ sql<string>`CAST(${JSON.stringify(Object.assign(JSON.parse(exceptionalJson), { parentId }))} AS TEXT)`
                      : jsonSetPath(
                          database.db,
                          transcriptEventJsonSql(database.db),
                          sql.lit("$.parentId"),
                          sql.val(parentId),
                        );
                return [
                  eb.val(sessionId).as("session_id"),
                  eb.val(destinationSeq).as("seq"),
                  eventJson.as("event_json"),
                  parentId === undefined
                    ? eb.ref("event_zstd").as("event_zstd")
                    : eb.val(null).as("event_zstd"),
                  parentId !== undefined && isPostgresSqlConnection(database.db)
                    ? eb.fn<number>("octet_length", [eventJson]).as("event_utf8_bytes")
                    : (parentId === undefined ? eb.ref("event_utf8_bytes") : eb.val(null)).as(
                        "event_utf8_bytes",
                      ),
                  parentId === undefined
                    ? eb.ref("navigation_json").as("navigation_json")
                    : eb.val(null).as("navigation_json"),
                  "navigation_type",
                  "navigation_custom_type",
                  "navigation_display",
                  "message_role",
                  "navigation_last_type",
                  "navigation_last_custom_type",
                  "navigation_valid",
                  "created_at",
                ];
              })
              .where("session_id", "=", sessionId)
              .where("seq", "=", sourceSeq),
          ),
      ),
  );
  if (copied.numAffectedRows !== 1n) {
    throw new Error("Retained transcript payload disappeared during suffix insertion");
  }
}
