import type { DatabaseSync } from "node:sqlite";
import { sql, type AliasedExpression, type Compilable } from "kysely";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type {
  TranscriptPageReadFailure,
  TranscriptPageReadLimits,
  TranscriptPageReadPosition,
  TranscriptPageReadRequest,
  TranscriptPageReadResult,
  TranscriptReadMeter,
} from "./session-transcript-page-read.types.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

class PageReadRefusal extends Error {
  constructor(readonly reason: TranscriptPageReadFailure) {
    super(reason);
  }
}

function validCount(value: number, ceiling: number) {
  return Number.isSafeInteger(value) && value > 0 && value <= ceiling;
}

export function createTranscriptReadMeter(limits: TranscriptPageReadLimits): TranscriptReadMeter {
  if (
    !validCount(limits.limit, 50) ||
    !validCount(limits.maxScannedEntries, 1_000) ||
    !validCount(limits.maxMaterializedBytes, 16 * 1024 * 1024)
  ) {
    throw new PageReadRefusal("resource_limit");
  }
  const captured = Object.freeze({ ...limits });
  let scannedEntries = 0;
  let materializedBytes = 0;
  let reservedEntries = 0;
  let reservedBytes = 0;
  let exhausted = false;
  return {
    limits: captured,
    reserve(entries, bytes) {
      if (![entries, bytes].every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new PageReadRefusal("read_failed");
      }
      if (
        entries > captured.maxScannedEntries - scannedEntries - reservedEntries ||
        bytes > captured.maxMaterializedBytes - materializedBytes - reservedBytes
      ) {
        exhausted = true;
        return undefined;
      }
      reservedEntries += entries;
      reservedBytes += bytes;
      let used = false;
      return {
        observe(observedEntries, observedBytes) {
          if (
            used ||
            ![observedEntries, observedBytes].every(
              (value) => Number.isSafeInteger(value) && value >= 0,
            ) ||
            observedEntries > entries ||
            observedBytes > bytes
          ) {
            throw new PageReadRefusal("read_failed");
          }
          used = true;
          reservedEntries -= entries;
          reservedBytes -= bytes;
          scannedEntries += observedEntries;
          materializedBytes += observedBytes;
        },
      };
    },
    snapshot: (final) => ({
      scannedEntries,
      materializedBytes,
      exhausted,
      // A failed native query can leave its fetch/decode amount unobserved.
      final: final && reservedEntries === 0 && reservedBytes === 0,
    }),
  };
}

// Each fetched source is one serialized JSON value, including scalar probes.
function readValue(
  database: DatabaseSync,
  query: Compilable<{ value: string | null }>,
  bytes: number,
  meter: TranscriptReadMeter,
): string | undefined {
  const reservation = meter.reserve(1, bytes);
  if (!reservation) {
    throw new PageReadRefusal("resource_limit");
  }
  const row = executeSqliteQueryTakeFirstSync(database, query);
  if (!row) {
    reservation.observe(0, 0);
    return undefined;
  }
  if (typeof row.value !== "string") {
    throw new PageReadRefusal("read_failed");
  }
  reservation.observe(1, Buffer.byteLength(row.value, "utf8"));
  return row.value;
}

function readBoundedValue(
  database: DatabaseSync,
  source: AliasedExpression<{ value: string | null }, "source">,
  meter: TranscriptReadMeter,
): string | undefined {
  const db = getNodeSqliteKysely<Record<string, never>>(database);
  const measured = readValue(
    database,
    db
      .selectFrom(source)
      .select(
        /* kysely-allow-raw: native length is serialized before returning bounded metadata text. */ sql<string>`json_quote(octet_length(source.value))`.as(
          "value",
        ),
      )
      .limit(1),
    32,
    meter,
  );
  if (measured === undefined) {
    return undefined;
  }
  const bytes: unknown = JSON.parse(measured);
  if (!Number.isSafeInteger(bytes) || Number(bytes) < 0) {
    throw new PageReadRefusal("read_failed");
  }
  return readValue(
    database,
    db.selectFrom(source).select("source.value").limit(1),
    Number(bytes),
    meter,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PageReadRefusal("read_failed");
  }
  return value as Record<string, unknown>;
}

function readPage(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  request: TranscriptPageReadRequest,
  meter: TranscriptReadMeter,
): Extract<TranscriptPageReadResult, { ok: true }>["value"] {
  const { scope } = request;
  if (database.agentId !== scope.agentId) {
    throw new PageReadRefusal("forbidden");
  }
  const db = getNodeSqliteKysely<DB>(database.db);
  // Only UTF-8 stores have exact native byte lengths for every serialized probe.
  const encoding = readValue(
    database.db,
    getNodeSqliteKysely<{ pragma_encoding: { encoding: string } }>(database.db)
      .selectFrom("pragma_encoding")
      .select(
        /* kysely-allow-raw: SQLite encoding has a closed bounded vocabulary. */ sql<string>`json_quote(encoding)`.as(
          "value",
        ),
      ),
    16,
    meter,
  );
  if (encoding !== '"UTF-8"') {
    throw new PageReadRefusal("unsupported");
  }
  const metadataJson = readBoundedValue(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(
        /* kysely-allow-raw: project only identity/lifecycle facts, never full private entry JSON. */ sql<string>`json_object('sessionId', current_session_id, 'revision', json_extract(entry_json, '$.lifecycleRevision'), 'archived', archived_at)`.as(
          "value",
        ),
      )
      .where("session_key", "=", scope.sessionKey)
      .as("source"),
    meter,
  );
  if (metadataJson === undefined) {
    throw new PageReadRefusal("missing");
  }
  const metadata = record(JSON.parse(metadataJson));
  if (
    metadata.sessionId !== scope.sessionId ||
    metadata.revision !== request.expectedLifecycleRevision ||
    metadata.archived !== null
  ) {
    throw new PageReadRefusal("stale_session");
  }
  const cold = readValue(
    database.db,
    db
      .selectFrom("session_transcript_cold_archives")
      .select(
        /* kysely-allow-raw: select a constant presence marker, never the archive payload. */
        sql<string>`'1'`.as("value"),
      )
      .where("session_id", "=", scope.sessionId)
      .limit(1),
    1,
    meter,
  );
  if (cold) {
    throw new PageReadRefusal("unsupported");
  }
  const generationJson = readBoundedValue(
    database.db,
    db
      .selectFrom("transcript_rewrite_watermarks")
      .select(
        /* kysely-allow-raw: serialize the existing generation, including escaping, before byte admission. */ sql<string>`json_quote(generation)`.as(
          "value",
        ),
      )
      .where("session_id", "=", scope.sessionId)
      .as("source"),
    meter,
  );
  if (generationJson === undefined) {
    throw new PageReadRefusal("unsupported");
  }
  const generation: unknown = JSON.parse(generationJson);
  if (typeof generation !== "string" || generation.length === 0) {
    throw new PageReadRefusal("read_failed");
  }
  const maxJson = readValue(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(
        /* kysely-allow-raw: serialize the indexed scalar frontier without fetching event bodies. */ sql<string>`json_quote(max(seq))`.as(
          "value",
        ),
      )
      .where("session_id", "=", scope.sessionId),
    32,
    meter,
  );
  const maxSeq: unknown = JSON.parse(maxJson ?? "null");
  if (maxSeq !== null && (!Number.isSafeInteger(maxSeq) || Number(maxSeq) < 0)) {
    throw new PageReadRefusal("read_failed");
  }
  const currentFrontier = maxSeq === null ? -1 : Number(maxSeq);
  const position = request.position;
  if (
    position &&
    (position.sessionId !== scope.sessionId ||
      position.lifecycleRevision !== metadata.revision ||
      position.generation !== generation)
  ) {
    throw new PageReadRefusal("stale_session");
  }
  if (
    position &&
    (![position.frontier, position.lastSeq].every((n) => Number.isSafeInteger(n) && n >= -1) ||
      position.lastSeq > position.frontier ||
      position.frontier > currentFrontier)
  ) {
    throw new PageReadRefusal("invalid_cursor");
  }
  let cursor: TranscriptPageReadPosition = position
    ? { ...position }
    : {
        sessionId: scope.sessionId,
        lifecycleRevision: request.expectedLifecycleRevision,
        generation,
        frontier: currentFrontier,
        lastSeq: -1,
      };
  const records: Extract<TranscriptPageReadResult, { ok: true }>["value"]["records"] = [];
  while (cursor.lastSeq < cursor.frontier && records.length < request.limits.limit) {
    try {
      const entry = db
        .selectFrom("transcript_events")
        .where("session_id", "=", scope.sessionId)
        .where("seq", ">", cursor.lastSeq)
        .where("seq", "<=", cursor.frontier)
        .orderBy("seq", "asc")
        .limit(1);
      const factsJson = readBoundedValue(
        database.db,
        entry
          .select(
            /* kysely-allow-raw: text uses its actual native length; compressed data uses the decoder-validated original size, without decompression. */ sql<string>`json_object('seq', seq, 'bytes', CASE WHEN event_json IS NOT NULL THEN octet_length(event_json) ELSE event_utf8_bytes END)`.as(
              "value",
            ),
          )
          .as("source"),
        meter,
      );
      if (!factsJson) {
        throw new PageReadRefusal("stale_session");
      }
      const facts = record(JSON.parse(factsJson));
      if (
        !Number.isSafeInteger(facts.seq) ||
        !Number.isSafeInteger(facts.bytes) ||
        Number(facts.bytes) < 0
      ) {
        throw new PageReadRefusal("read_failed");
      }
      const raw = readValue(
        database.db,
        entry.select(transcriptEventJsonSql(database.db).as("value")),
        Number(facts.bytes),
        meter,
      );
      if (raw === undefined) {
        throw new PageReadRefusal("stale_session");
      }
      const event: unknown = JSON.parse(raw);
      const id = record(event).id;
      if (typeof id !== "string" || id.length === 0) {
        throw new PageReadRefusal("unsupported");
      }
      const afterPosition = { ...cursor, lastSeq: Number(facts.seq) };
      records.push({ storedEntryId: id, event, beforePosition: cursor, afterPosition });
      cursor = afterPosition;
    } catch (error) {
      if (
        error instanceof PageReadRefusal &&
        error.reason === "resource_limit" &&
        records.length > 0
      ) {
        break;
      }
      throw error;
    }
  }
  return {
    generation,
    records,
    ...(cursor.lastSeq < cursor.frontier ? { nextPosition: cursor } : {}),
  };
}

/** The caller supplies an admitted read-only handle and keeps its source custody. */
export function readTranscriptPageInDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  request: TranscriptPageReadRequest,
  meter: TranscriptReadMeter,
): TranscriptPageReadResult {
  try {
    if (
      Object.keys(meter.limits).some(
        (key) =>
          request.limits[key as keyof TranscriptPageReadLimits] !==
          meter.limits[key as keyof TranscriptPageReadLimits],
      )
    ) {
      throw new PageReadRefusal("resource_limit");
    }
    const value = runSqliteDeferredTransactionSync(database.db, () =>
      readPage(database, request, meter),
    );
    return { ok: true, value, budget: meter.snapshot(true) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof PageReadRefusal ? error.reason : "read_failed",
      budget: meter.snapshot(true),
    };
  }
}
