import type { SQLInputValue } from "node:sqlite";
import { sql, type RawBuilder, type SqlBool } from "kysely";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import {
  jsonNativeFieldsValid,
  jsonPathValue,
  jsonType,
} from "../../infra/database-engine/json-values.js";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "../../infra/sql-connection.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  transcriptEventDependencyNavigationSql,
  isHistoricalTranscriptActiveFactsSchema,
  TRANSCRIPT_INSERT_BATCH_SIZE,
  type TranscriptPayloadRecord,
  type TranscriptPayloadAlias,
} from "./transcript-payload.js";

export type SessionTranscriptActiveFacts = { serializedBytes: number } & (
  | { dependencyNavigationJson: string }
  | { payload: TranscriptPayloadRecord }
);
export type SessionTranscriptActiveFactsRow = {
  eventSeq: number;
  contextEligible: number | null;
  facts?: SessionTranscriptActiveFacts;
};

type FactsInput = {
  seq: number;
  context_eligible: number | null;
  serialized_bytes: number;
  dependency_navigation_json: string | null;
  event_json: string | null;
  navigation_json: string | null;
  navigation_type: string | null;
  navigation_valid: number | null;
  message_role: string | null;
};

/** Exceptional legacy shapes keep projection failures at the existing read boundary. */
export function transcriptDependencyFactsProjectableSql(
  database: EngineConnection,
  alias: TranscriptPayloadAlias,
): RawBuilder<SqlBool> {
  const identity =
    /* kysely-allow-raw: closed payload aliases name already prepared or stored writer inputs. */ sql.ref(
      `${alias}.event_json`,
    );
  const navigation =
    /* kysely-allow-raw: closed payload aliases name validated envelopes with the exact model projection. */ sql.ref(
      `${alias}.navigation_json`,
    );
  if (isPostgresSqlConnection(database)) {
    return /* kysely-allow-raw: PG's model projection guards scalar data; only native JSON validity is needed. */ sql<SqlBool>`${navigation} IS NOT NULL OR ${jsonNativeFieldsValid(database, identity)}`;
  }
  return /* kysely-allow-raw: SQLite json_each(json_extract(data)) treats text as JSON source; do not eagerly parse legacy scalar placement data. */ sql<SqlBool>`CASE WHEN ${navigation} IS NOT NULL THEN 1
    WHEN NOT ${jsonNativeFieldsValid(database, identity)} THEN 0
    WHEN ${jsonPathValue(database, identity, sql.lit("$.type"))} = 'custom'
      AND ${jsonPathValue(database, identity, sql.lit("$.customType"))} = ${BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE}
      AND ${jsonType(database, identity, sql.lit("$.data"))} = 'text' THEN 0 ELSE 1 END`;
}

/** Inputs come from the payload writer; no payload-table lookup is needed. */
export function prepareSessionTranscriptActiveFacts(
  payload: TranscriptPayloadRecord,
  contextEligible: number | null,
  serializedBytes: number,
): SessionTranscriptActiveFacts | undefined {
  // Invalid or native-depth-exceeding input keeps its existing read-time behavior.
  if (payload.navigation_valid === 0) {
    return undefined;
  }
  const candidate =
    payload.navigation_type === null ||
    payload.navigation_type === "custom" ||
    payload.navigation_type === "reset" ||
    (payload.navigation_type === "message" &&
      contextEligible === 0 &&
      payload.message_role === "assistant");
  return candidate
    ? { serializedBytes, payload }
    : { serializedBytes, dependencyNavigationJson: "{}" };
}

/** The PG caller can depend on its active-row RETURNING CTE before inserting children. */
export function buildSessionTranscriptActiveFactsInsert(
  database: EngineConnection,
  sessionId: string | RawBuilder<string>,
  count: number,
  parameter: <T extends SQLInputValue>(
    read: (rows: readonly SessionTranscriptActiveFactsRow[]) => T,
  ) => RawBuilder<T>,
  activeReturning = false,
  finalized = false,
) {
  const db = getNodeSqliteKysely<DB>(database);
  const readNavigation = (row: SessionTranscriptActiveFactsRow) => {
    const facts = row.facts!;
    return "dependencyNavigationJson" in facts ? facts.dependencyNavigationJson : null;
  };
  if (finalized && !activeReturning) {
    return db.insertInto("session_transcript_active_event_facts").values(
      Array.from({ length: count }, (_, index) => ({
        session_id: sessionId,
        seq: parameter((rows) => rows[index]!.eventSeq),
        serialized_bytes: parameter((rows) => rows[index]!.facts!.serializedBytes),
        dependency_navigation_json: parameter((rows) => readNavigation(rows[index]!)!),
      })),
    );
  }
  const postgres = isPostgresSqlConnection(database);
  const sourceFields: {
    [Key in keyof FactsInput]: (row: SessionTranscriptActiveFactsRow) => FactsInput[Key];
  } = {
    seq: (row) => row.eventSeq,
    context_eligible: (row) => row.contextEligible,
    serialized_bytes: (row) => row.facts!.serializedBytes,
    dependency_navigation_json: readNavigation,
    event_json: (row) =>
      row.facts && "payload" in row.facts ? row.facts.payload.event_json : null,
    navigation_json: (row) =>
      row.facts && "payload" in row.facts ? row.facts.payload.navigation_json : null,
    navigation_type: (row) =>
      row.facts && "payload" in row.facts ? row.facts.payload.navigation_type : null,
    navigation_valid: (row) =>
      row.facts && "payload" in row.facts ? row.facts.payload.navigation_valid : null,
    message_role: (row) =>
      row.facts && "payload" in row.facts ? row.facts.payload.message_role : null,
  };
  const columns: (keyof FactsInput)[] = finalized
    ? ["seq", "serialized_bytes", "dependency_navigation_json"]
    : [
        "seq",
        "context_eligible",
        "serialized_bytes",
        "dependency_navigation_json",
        "event_json",
        "navigation_json",
        "navigation_type",
        "navigation_valid",
        "message_role",
      ];
  const numeric = new Set<keyof FactsInput>([
    "seq",
    "context_eligible",
    "serialized_bytes",
    "navigation_valid",
  ]);
  const input = /* kysely-allow-raw: bounded prepared rows supply the fixed CTE input, without payload-table reads. */ sql<FactsInput>`(values ${sql.join(
    Array.from(
      { length: count },
      (_, index) =>
        /* kysely-allow-raw: each fixed VALUES tuple contains bound writer facts only. */ sql`(${sql.join(
          columns.map((column) => {
            const value = parameter((rows) => sourceFields[column](rows[index]!));
            // The column list owns each binding's native type, including all-NULL batches.
            return postgres
              ? /* kysely-allow-raw: the closed input-column set selects only PG bigint or text casts. */ sql`${value}::${sql.raw(numeric.has(column) ? "bigint" : "text")}`
              : value;
          }),
        )})`,
    ),
  )})`;
  return db
    .with(
      finalized
        ? "active_fact_input(seq, serialized_bytes, dependency_navigation_json)"
        : "active_fact_input(seq, context_eligible, serialized_bytes, dependency_navigation_json, event_json, navigation_json, navigation_type, navigation_valid, message_role)",
      () => input,
    )
    .insertInto("session_transcript_active_event_facts")
    .columns(["session_id", "seq", "serialized_bytes", "dependency_navigation_json"])
    .expression((query) =>
      query
        .selectFrom("active_fact_input as event")
        .select((eb) => [
          typeof sessionId === "string"
            ? eb.val(sessionId).as("session_id")
            : sessionId.as("session_id"),
          "event.seq",
          "event.serialized_bytes",
          finalized
            ? /* kysely-allow-raw: finalized inputs carry the required non-null navigation string. */ sql<string>`event.dependency_navigation_json`.as(
                "dependency_navigation_json",
              )
            : /* kysely-allow-raw: finalized rebuild facts bypass the exact bound-payload projection. */ sql<string>`CASE WHEN event.dependency_navigation_json IS NOT NULL
            THEN event.dependency_navigation_json
            ELSE ${transcriptEventDependencyNavigationSql(database, eb.ref("event.context_eligible"), "event")} END`.as(
                "dependency_navigation_json",
              ),
        ])
        .$if(!finalized, (select) =>
          select.where((eb) =>
            eb.or([
              eb("event.dependency_navigation_json", "is not", null),
              transcriptDependencyFactsProjectableSql(database, "event"),
            ]),
          ),
        )
        .$if(activeReturning, (select) =>
          select.where(
            /* kysely-allow-raw: the PG active writer's RETURNING relation orders the child FK insert. */ sql<boolean>`event.seq IN (SELECT event_seq FROM projection_active)`,
          ),
        ),
    );
}

type FactsWrite = { sessionId: string; rows: readonly SessionTranscriptActiveFactsRow[] };
const activeFactsWrites = createSqliteQueryCache((database: EngineConnection) => {
  const prepare = (count: number, finalized: boolean) =>
    prepareSqliteQuerySync<FactsWrite>(database, (parameter) =>
      buildSessionTranscriptActiveFactsInsert(
        database,
        parameter((input) => input.sessionId),
        count,
        (read) => parameter((input) => read(input.rows)),
        false,
        finalized,
      ),
    );
  const singles: [ReturnType<typeof prepare>?, ReturnType<typeof prepare>?] = [];
  const fulls: [ReturnType<typeof prepare>?, ReturnType<typeof prepare>?] = [];
  return {
    forCount(count: number, finalized: boolean) {
      const mode = finalized ? 1 : 0;
      // Keep only single/full templates for each input shape, never every partial chunk.
      return count === 1
        ? (singles[mode] ??= prepare(count, finalized))
        : count === TRANSCRIPT_INSERT_BATCH_SIZE
          ? (fulls[mode] ??= prepare(count, finalized))
          : prepare(count, finalized);
    },
  };
});

export function createSessionTranscriptActiveFactsInserter(
  database: EngineConnection,
  sessionId: string,
) {
  const writes = activeFactsWrites(database);
  return (rows: readonly SessionTranscriptActiveFactsRow[]) => {
    if (isHistoricalTranscriptActiveFactsSchema(database)) {
      return;
    }
    const known = rows.filter((row) => row.facts !== undefined);
    if (known.length === 0) {
      return;
    }
    for (let offset = 0; offset < known.length; offset += TRANSCRIPT_INSERT_BATCH_SIZE) {
      const chunk = known.slice(offset, offset + TRANSCRIPT_INSERT_BATCH_SIZE);
      const finalized = chunk.every((row) => row.facts && "dependencyNavigationJson" in row.facts);
      writes.forCount(chunk.length, finalized)({ sessionId, rows: chunk });
    }
  };
}
