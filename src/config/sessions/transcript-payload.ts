import { sql, type Expression, type RawBuilder } from "kysely";
import {
  jsonPathValue,
  jsonRemovePaths,
  jsonValid,
} from "../../infra/database-engine/json-values.js";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { supportsNodeSqliteJsonb } from "../../infra/node-sqlite.js";
import { isPostgresSqlConnection, type EngineConnection } from "../../infra/sql-connection.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { findSessionTranscriptHeader } from "./session-entry-codec.js";
import {
  projectModelContextEventSql,
  projectModelContextNavigationSql,
  projectResetBoundaryNavigationSql,
  projectTranscriptPayloadNavigationSql,
} from "./session-model-context-projection.js";
import { projectSessionTranscriptReportFacts } from "./session-transcript-report-facts.js";
import {
  MAX_COMPRESSED_EVENT_BYTES,
  type TranscriptPayloadAlias,
} from "./transcript-payload-read.js";
import {
  deriveTranscriptPredicateFields,
  type TranscriptPredicateFields,
} from "./transcript-predicate-fields.js";

export {
  MAX_COMPRESSED_EVENT_BYTES,
  readTranscriptPayload,
  transcriptEventJsonSql,
  type TranscriptPayloadAlias,
} from "./transcript-payload-read.js";

const MAX_NAVIGATION_BYTES = 16 * 1024;
const MIN_COMPRESS_BYTES = 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type TranscriptPayloadRecord = TranscriptPredicateFields & {
  event_json: string | null;
  event_zstd: Uint8Array | null;
  event_utf8_bytes: number | null;
  navigation_json: string | null;
};

export type PreparedTranscriptPayload = {
  eventJson: string;
  storageEncoding: string;
  payload: TranscriptPayloadRecord;
};

export type TranscriptEventInsertRow = {
  seq: number;
  eventJson: string;
  createdAt: number;
  eventId?: string;
  parsedEvent?: unknown;
  preparedPayload?: PreparedTranscriptPayload;
};

// Fourteen bound columns per row use at most 7,168 parameters on either engine.
export const TRANSCRIPT_INSERT_BATCH_SIZE = 512;

/** Physical payload writes participate in the transcript owner's admitted transaction. */
export function createTranscriptEventInserter(database: EngineConnection, sessionId: string) {
  const kysely =
    getNodeSqliteKysely<Pick<DB, "transcript_events" | "transcript_event_identities">>(database);
  const prepareRow = (row: TranscriptEventInsertRow) => {
    const prepared = row.preparedPayload;
    const payload =
      prepared?.eventJson === row.eventJson &&
      prepared.storageEncoding === readTranscriptStorageEncoding(database) &&
      (!isPostgresSqlConnection(database) || prepared.payload.event_zstd === null)
        ? prepared.payload
        : prepareTranscriptPayload(database, row.eventJson, row.parsedEvent);
    return { session_id: sessionId, seq: row.seq, ...payload, created_at: row.createdAt };
  };
  type StoredRow = ReturnType<typeof prepareRow>;
  const columns = [
    "session_id",
    "seq",
    "event_json",
    "event_zstd",
    "event_utf8_bytes",
    "navigation_json",
    "navigation_type",
    "navigation_custom_type",
    "navigation_display",
    "message_role",
    "navigation_last_type",
    "navigation_last_custom_type",
    "navigation_valid",
    "created_at",
  ] as const;
  // Each executor is used only with the chunk length that defines its bound indexes.
  const createBatchInsert = (count: number) =>
    prepareSqliteQuerySync<readonly StoredRow[]>(database, (parameter) =>
      kysely.insertInto("transcript_events").values(
        Array.from({ length: count }, (_, index) => ({
          session_id: sessionId,
          seq: parameter((rows) => rows[index]!.seq),
          event_json: parameter((rows) => rows[index]!.event_json),
          event_zstd: parameter((rows) => rows[index]!.event_zstd),
          event_utf8_bytes: parameter((rows) => rows[index]!.event_utf8_bytes),
          navigation_json: parameter((rows) => rows[index]!.navigation_json),
          navigation_type: parameter((rows) => rows[index]!.navigation_type),
          navigation_custom_type: parameter((rows) => rows[index]!.navigation_custom_type),
          navigation_display: parameter((rows) => rows[index]!.navigation_display),
          message_role: parameter((rows) => rows[index]!.message_role),
          navigation_last_type: parameter((rows) => rows[index]!.navigation_last_type),
          navigation_last_custom_type: parameter(
            (rows) => rows[index]!.navigation_last_custom_type,
          ),
          navigation_valid: parameter((rows) => rows[index]!.navigation_valid),
          created_at: parameter((rows) => rows[index]!.created_at),
        })),
      ),
    );
  const batchInserts = new Map<number, ReturnType<typeof createBatchInsert>>();
  const batch = (rows: readonly TranscriptEventInsertRow[]) => {
    for (let offset = 0; offset < rows.length; offset += TRANSCRIPT_INSERT_BATCH_SIZE) {
      const prepared = rows.slice(offset, offset + TRANSCRIPT_INSERT_BATCH_SIZE).map(prepareRow);
      let insert = batchInserts.get(prepared.length);
      if (!insert) {
        insert = createBatchInsert(prepared.length);
        batchInserts.set(prepared.length, insert);
      }
      insert(prepared);
    }
  };
  const createIdentityInsert = () =>
    prepareSqliteQueryTakeFirstSync<StoredRow & { eventId: string }, { seq: number }>(
      database,
      (parameter) =>
        kysely
          .insertInto("transcript_events")
          .columns(columns)
          .expression(
            kysely
              .selectNoFrom(columns.map((column) => parameter((row) => row[column]).as(column)))
              .where((eb) =>
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom("transcript_event_identities")
                      .select("event_id")
                      .where("session_id", "=", sessionId)
                      .where(
                        "event_id",
                        "=",
                        parameter((row) => row.eventId),
                      ),
                  ),
                ),
              ),
          )
          .returning("seq"),
    );
  let insertIdentity: ReturnType<typeof createIdentityInsert> | undefined;
  return Object.assign(
    (row: TranscriptEventInsertRow): boolean => {
      if (row.eventId === undefined) {
        batch([row]);
        return true;
      }
      insertIdentity ??= createIdentityInsert();
      return insertIdentity({ ...prepareRow(row), eventId: row.eventId }) !== undefined;
    },
    { batch },
  );
}

export function createTranscriptPayloadUpdater(database: EngineConnection, sessionId: string) {
  return prepareSqliteQuerySync<TranscriptPayloadRecord & { seq: number }>(database, (parameter) =>
    getNodeSqliteKysely<Pick<DB, "transcript_events">>(database)
      .updateTable("transcript_events")
      .set({
        event_json: parameter((row) => row.event_json),
        event_zstd: parameter((row) => row.event_zstd),
        event_utf8_bytes: parameter((row) => row.event_utf8_bytes),
        navigation_json: parameter((row) => row.navigation_json),
        navigation_type: parameter((row) => row.navigation_type),
        navigation_custom_type: parameter((row) => row.navigation_custom_type),
        navigation_display: parameter((row) => row.navigation_display),
        message_role: parameter((row) => row.message_role),
        navigation_last_type: parameter((row) => row.navigation_last_type),
        navigation_last_custom_type: parameter((row) => row.navigation_last_custom_type),
        navigation_valid: parameter((row) => row.navigation_valid),
      })
      .where("session_id", "=", sessionId)
      .where(
        "seq",
        "=",
        parameter((row) => row.seq),
      ),
  );
}

export function readTranscriptStorageEncoding(database: EngineConnection): string {
  if (isPostgresSqlConnection(database)) {
    return "UTF-8";
  }
  const facts = getAdmittedSqliteSchemaFacts(database);
  if (!facts) {
    throw new Error("Transcript payload preparation requires admitted SQLite schema facts");
  }
  return facts.textEncoding;
}

/** Matches stored transcript byte accounting, including the exported JSONL newline. */
export function transcriptSerializedBytes(database: EngineConnection, eventJson: string): number {
  const encoding = readTranscriptStorageEncoding(database) === "UTF-8" ? "utf8" : "utf16le";
  return Buffer.byteLength(eventJson, encoding) + 1;
}

/** Prepared bytes grant no write authority and must match the eventual envelope and encoding. */
export function prepareTranscriptPayloadForReuse(
  database: EngineConnection,
  eventJson: string,
  parsedEvent?: unknown,
): PreparedTranscriptPayload {
  const storageEncoding = readTranscriptStorageEncoding(database);
  return {
    eventJson,
    storageEncoding,
    payload: prepareTranscriptPayload(database, eventJson, parsedEvent, storageEncoding),
  };
}

function navigationProjection(
  database: EngineConnection,
  event: Expression<string | Uint8Array>,
  report: Expression<string>,
  originalEvent: Expression<string>,
): RawBuilder<string | null> {
  return /* kysely-allow-raw: record native projections and exact byte costs; exceptional envelopes retain identity behavior. */ sql<
    string | null
  >`CASE WHEN json_valid(${originalEvent}) AND json_valid(${report}) THEN CASE
    WHEN json_type(${event}) != 'object'
      OR coalesce(json_type(${event}, '$.message'), 'null') NOT IN ('object', 'null') THEN NULL
    ELSE json_object('version', 1,
      'report', json(${report}),
      'navigation', json(${projectTranscriptPayloadNavigationSql(database, event)}),
      'reset', json(${projectResetBoundaryNavigationSql(database, originalEvent)}),
      'model', json(${projectModelContextNavigationSql(database, event)}),
      'modelBytes', octet_length(${projectModelContextEventSql(database, event, sql.lit(0))}),
      'modelWithoutCheckpointBytes', octet_length(${projectModelContextEventSql(database, event, sql.lit(1))}),
      'withoutCustomDataBytes', octet_length(json_remove(${event}, '$.data')))
    END ELSE NULL END`;
}

type NavigationInput = { eventJson: string; reportJson: string };
const navigationReader = createSqliteQueryCache((database: EngineConnection) =>
  prepareSqliteQueryTakeFirstSync<NavigationInput, { navigation_json: string | null }>(
    database,
    (parameter) => {
      const db = getNodeSqliteKysely<Record<string, never>>(database);
      const source = db
        .selectFrom(
          db
            .selectNoFrom([
              parameter((value) => value.eventJson).as("event_json"),
              parameter((value) => value.reportJson).as("report_json"),
            ])
            .as("input"),
        )
        .select(["input.event_json", "input.report_json"])
        .select((eb) =>
          supportsNodeSqliteJsonb()
            ? /* kysely-allow-raw: reuse native binary JSON only after the existing strict text validation. */ sql<
                string | Uint8Array
              >`CASE WHEN json_valid(${eb.ref("input.event_json")})
                  THEN jsonb(${eb.ref("input.event_json")}) ELSE ${eb.ref("input.event_json")} END`.as(
                "event_projection",
              )
            : eb.ref("input.event_json").as("event_projection"),
        );
      const admitted = /* kysely-allow-raw: reject oversized metadata natively before returning its text to JavaScript. */ sql<
        string | null
      >`CASE WHEN json_valid(metadata.navigation_json)
          AND octet_length(metadata.navigation_json) <= ${MAX_NAVIGATION_BYTES}
          THEN metadata.navigation_json ELSE NULL END`;
      return (
        db
          // Full JSON and JSONB intermediates can spill to disk when materialized.
          .with(
            (cte) => cte("source").notMaterialized(),
            () => source,
          )
          // The size guard and returned value must reuse one envelope, not flatten into two projections.
          .with(
            (cte) => cte("metadata").materialized(),
            (cteDb) =>
              cteDb
                .selectFrom("source")
                .select((eb) =>
                  navigationProjection(
                    database,
                    eb.ref("source.event_projection"),
                    eb.ref("source.report_json"),
                    eb.ref("source.event_json"),
                  ).as("navigation_json"),
                ),
          )
          .selectFrom("metadata")
          .select(admitted.as("navigation_json"))
      );
    },
  ),
);

/** Prepare canonical UTF-8 bytes and native query metadata before publishing a transcript row. */
export function prepareTranscriptPayload(
  database: EngineConnection,
  eventJson: string,
  parsedEvent?: unknown,
  storageEncoding = readTranscriptStorageEncoding(database),
): TranscriptPayloadRecord {
  const rawBytes = Buffer.byteLength(eventJson, "utf8");
  const utf8 = storageEncoding === "UTF-8";
  const identity: TranscriptPayloadRecord = {
    ...deriveTranscriptPredicateFields(eventJson),
    event_json: eventJson,
    event_zstd: null,
    event_utf8_bytes: utf8 ? rawBytes : null,
    navigation_json: null,
  };
  // PostgreSQL rows never carry event_zstd; TOAST owns their physical compression.
  if (isPostgresSqlConnection(database)) {
    return identity;
  }
  // Giant identity values stay available to native SQL without a second full buffer or projection.
  // SQLite and JS can disagree on escaped surrogates and embedded NUL; retain the native path.
  if (
    !utf8 ||
    rawBytes > MAX_COMPRESSED_EVENT_BYTES ||
    eventJson.includes("\\u") ||
    eventJson.includes("\0")
  ) {
    return identity;
  }
  const codec = resolveZstdCodec();
  if (rawBytes < MIN_COMPRESS_BYTES) {
    return identity;
  }
  const bytes = Buffer.from(eventJson, "utf8");
  // A literal unpaired surrogate cannot round-trip through a UTF-8 frame.
  if (utf8Decoder.decode(bytes) !== eventJson) {
    return identity;
  }
  const compressed = codec.compress(bytes, 1, true);
  const maximumStoredBytes = rawBytes - Math.max(64, Math.ceil(rawBytes / 10));
  if (compressed.byteLength > maximumStoredBytes) {
    return identity;
  }
  let reportJson: string;
  try {
    // Prepared appends already decoded these exact bytes before taking the writer lock.
    const raw: unknown = parsedEvent === undefined ? JSON.parse(eventJson) : parsedEvent;
    // Header discovery must keep the original version and coercion behavior.
    if (findSessionTranscriptHeader([raw])) {
      return identity;
    }
    reportJson = JSON.stringify(projectSessionTranscriptReportFacts(raw));
  } catch {
    // Unsupported JSON or projection nesting must not reject existing identity bytes.
    return identity;
  }
  const navigation = navigationReader(database)({ eventJson, reportJson })?.navigation_json ?? null;
  if (
    navigation === null ||
    compressed.byteLength + Buffer.byteLength(navigation, "utf8") > maximumStoredBytes
  ) {
    return identity;
  }
  return { ...identity, event_json: null, event_zstd: compressed, navigation_json: navigation };
}

export function transcriptEventNavigationSql(
  database: EngineConnection,
  alias: TranscriptPayloadAlias = "transcript_events",
): RawBuilder<string> {
  const identity =
    /* kysely-allow-raw: closed transcript aliases select the native identity fallback. */ sql.ref<string>(
      `${alias}.event_json`,
    );
  return storedProjectionSql(database, "navigation", identity, alias);
}

/** Old SQLite transcripts keep lazy predicates until their next payload write. */
export function transcriptPredicateSql<K extends keyof TranscriptPredicateFields>(
  database: EngineConnection,
  field: K,
  alias: TranscriptPayloadAlias = "transcript_events",
): RawBuilder<TranscriptPredicateFields[K]> {
  const stored =
    /* kysely-allow-raw: closed payload aliases and predicate keys name persisted owner facts. */
    sql.ref<TranscriptPredicateFields[K]>(`${alias}.${field}`);
  // PostgreSQL starts with materialized predicates, including SQLite port imports.
  if (isPostgresSqlConnection(database)) {
    return stored;
  }
  const type =
    /* kysely-allow-raw: the closed payload alias selects the classification marker. */
    sql.ref(`${alias}.navigation_type`);
  const valid =
    /* kysely-allow-raw: the closed payload alias selects recorded validity. */
    sql.ref(`${alias}.navigation_valid`);
  const identity =
    /* kysely-allow-raw: the closed payload alias selects the canonical raw identity. */
    sql.ref(`${alias}.event_json`);
  const metadata =
    /* kysely-allow-raw: closed payload aliases select the duplicate-preserving navigation envelope. */
    sql.ref(`${alias}.navigation_json`);
  const source = sql`coalesce(${identity}, ${jsonPathValue(database, metadata, sql.lit("$.navigation"), "json")})`;
  const sourceValid = jsonValid(database, source);
  const event = sql`CASE WHEN ${sourceValid} THEN ${source} ELSE '{}' END`;
  let derived: RawBuilder<unknown>;
  if (field === "navigation_valid") {
    derived = sql`coalesce(${sourceValid}, 0)`;
  } else if (field === "navigation_display") {
    derived =
      /* kysely-allow-raw: SQLite-only legacy classification preserves JSON true versus numeric one. */
      sql`CASE WHEN json_type(${event}, '$.display') = 'true' THEN 1 ELSE 0 END`;
  } else {
    const isCustom = field === "navigation_custom_type" || field === "navigation_last_custom_type";
    const path = field === "message_role" ? "$.message.role" : isCustom ? "$.customType" : "$.type";
    const value =
      field === "navigation_last_type" || field === "navigation_last_custom_type"
        ? /* kysely-allow-raw: SQLite-only legacy navigation uses the final duplicate root member. */
          sql`(SELECT value FROM json_each(${event}) WHERE key = ${sql.lit(isCustom ? "customType" : "type")} ORDER BY id DESC LIMIT 1)`
        : jsonPathValue(database, event, sql.lit(path));
    const accepted =
      field === "message_role"
        ? ["user", "assistant", "toolResult", "system"]
        : isCustom
          ? ["openclaw.runtime-context", "openclaw.cache-ttl"]
          : ["session", "message", "reset", "compaction", "custom_message", "custom"];
    derived = sql`CASE WHEN ${value} IN (${sql.join(accepted.map((candidate) => sql.lit(candidate)))}) THEN ${value} END`;
  }
  // A valid unknown type shares legacy defaults and can harmlessly rederive.
  // Classified and malformed rows never parse their payload again here.
  return /* kysely-allow-raw: closed predicate keys select matching stored and derived owner facts. */ sql<
    TranscriptPredicateFields[K]
  >`CASE WHEN ${type} IS NOT NULL OR ${valid} = 0
    THEN ${stored} ELSE ${derived} END`;
}

export function transcriptEventRunIdSql(
  database: EngineConnection,
  alias: TranscriptPayloadAlias = "transcript_events",
): RawBuilder<string | null> {
  return jsonPathValue(
    database,
    transcriptEventNavigationSql(database, alias),
    sql.lit("$.message.__openclaw.runId"),
  );
}

function storedProjectionSql(
  database: EngineConnection,
  field: "navigation" | "reset" | "model",
  fallback: Expression<string>,
  alias: TranscriptPayloadAlias,
): RawBuilder<string> {
  const metadata =
    /* kysely-allow-raw: closed transcript aliases select the native navigation envelope. */ sql.ref(
      `${alias}.navigation_json`,
    );
  return /* kysely-allow-raw: exceptional identity rows retain native projection; other rows use the recorded owner projection. */ sql<string>`CASE WHEN ${metadata} IS NULL THEN ${fallback}
    ELSE ${jsonPathValue(database, metadata, sql.val(`$.${field}`), "json")} END`;
}

export function transcriptEventResetNavigationSql(
  database: EngineConnection,
  alias: TranscriptPayloadAlias = "transcript_events",
): RawBuilder<string> {
  const identity =
    /* kysely-allow-raw: closed transcript aliases select the native identity fallback. */ sql.ref<string>(
      `${alias}.event_json`,
    );
  return storedProjectionSql(
    database,
    "reset",
    projectResetBoundaryNavigationSql(database, identity),
    alias,
  );
}

export function transcriptEventModelNavigationSql(
  database: EngineConnection,
  alias: TranscriptPayloadAlias = "transcript_events",
  entryType?: Expression<unknown>,
): RawBuilder<string> {
  const identity =
    /* kysely-allow-raw: closed transcript aliases select the native identity fallback. */ sql.ref<string>(
      `${alias}.event_json`,
    );
  return storedProjectionSql(
    database,
    "model",
    projectModelContextNavigationSql(database, identity, entryType),
    alias,
  );
}

/** Model admission retains projected byte costs, which can be much smaller than canonical JSON. */
export function transcriptEventModelBytesSql(
  database: EngineConnection,
  omitCheckpoint: Expression<number>,
  alias: TranscriptPayloadAlias = "transcript_events",
): RawBuilder<number> {
  const metadata =
    /* kysely-allow-raw: closed transcript aliases select native projection accounting. */ sql.ref(
      `${alias}.navigation_json`,
    );
  const identity =
    /* kysely-allow-raw: closed transcript aliases select the native identity fallback. */ sql.ref<string>(
      `${alias}.event_json`,
    );
  return /* kysely-allow-raw: native fallback preserves UTF-16 byte units; metadata excludes the JSONL separator. */ sql<number>`CASE WHEN ${metadata} IS NULL
    THEN octet_length(${projectModelContextEventSql(database, identity, omitCheckpoint)})
    ELSE ${jsonPathValue(
      database,
      metadata,
      sql`CASE WHEN ${omitCheckpoint} = 1
      THEN '$.modelWithoutCheckpointBytes' ELSE '$.modelBytes' END`,
      "number",
    )} END`;
}

/** Suffix admission can retain opaque custom data without charging or decoding its body. */
export function transcriptEventWithoutCustomDataBytesSql(
  database: EngineConnection,
  alias: TranscriptPayloadAlias = "transcript_events",
): RawBuilder<number> {
  const metadata =
    /* kysely-allow-raw: closed transcript aliases select native projection accounting. */ sql.ref(
      `${alias}.navigation_json`,
    );
  const identity =
    /* kysely-allow-raw: closed transcript aliases select the native identity fallback. */ sql.ref(
      `${alias}.event_json`,
    );
  return /* kysely-allow-raw: preserve the native json_remove cost used by retained-custom suffix projection. */ sql<number>`CASE WHEN ${metadata} IS NULL
    THEN octet_length(${jsonRemovePaths(database, identity, [sql.lit("$.data")])})
    ELSE ${jsonPathValue(database, metadata, sql.lit("$.withoutCustomDataBytes"), "number")} END`;
}

export function transcriptEventUtf8BytesSql(
  alias: TranscriptPayloadAlias = "transcript_events",
): RawBuilder<number | null> {
  return /* kysely-allow-raw: closed transcript aliases select known UTF-8 bytes without loading payloads. */ sql.ref<
    number | null
  >(`${alias}.event_utf8_bytes`);
}
