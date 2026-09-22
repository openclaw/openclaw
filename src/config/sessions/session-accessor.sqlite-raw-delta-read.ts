import { sql } from "kysely";
import { getNodeSqliteKysely, executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptRawDeltaResult,
} from "./session-accessor.sqlite-contract.js";
import type { CurrentTranscriptProjection } from "./session-accessor.sqlite-projection-read.js";
import type { resolveSqliteTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import { readSessionTranscriptHotWatermark } from "./session-accessor.sqlite-transcript-watermark-read.js";
import { normalizeVisibleMessageLimit } from "./session-accessor.sqlite-visible-cursor.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

const RAW_TRANSCRIPT_CURSOR_VERSION = 1;
const DEFAULT_RAW_TRANSCRIPT_MAX_EVENTS = 1_000;
const DEFAULT_RAW_TRANSCRIPT_MAX_BYTES = 1_000_000;
const MAX_RAW_TRANSCRIPT_EVENTS = 10_000;
const MAX_RAW_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

type RawTranscriptCursor = {
  agentId: string;
  generation: string;
  lastSeq: number;
  sessionId: string;
  version: typeof RAW_TRANSCRIPT_CURSOR_VERSION;
};

type ResolvedTranscriptReadScope = ReturnType<typeof resolveSqliteTranscriptReadScope>;

function encodeRawTranscriptCursor(cursor: RawTranscriptCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Mint the raw-delta cursor for a generation-consistent transcript snapshot. */
export function createTranscriptRawDeltaCursor(params: {
  agentId: string;
  generation: string;
  lastSeq: number;
  sessionId: string;
}): string {
  return encodeRawTranscriptCursor({ ...params, version: RAW_TRANSCRIPT_CURSOR_VERSION });
}

function parseRawTranscriptCursor(value: string): RawTranscriptCursor | undefined {
  if (value.length > 4_096) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<RawTranscriptCursor>; // SAFETY: Checks and catch reject invalid cursor shapes.
    if (
      parsed.version !== RAW_TRANSCRIPT_CURSOR_VERSION ||
      typeof parsed.agentId !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.generation !== "string" ||
      !Number.isSafeInteger(parsed.lastSeq) ||
      (parsed.lastSeq ?? -2) < -1
    ) {
      return undefined;
    }
    // SAFETY: All required fields and the sequence range passed validation above.
    return parsed as RawTranscriptCursor;
  } catch {
    return undefined;
  }
}

function bootstrapCursor(
  scope: ResolvedTranscriptReadScope,
  generation: string,
): RawTranscriptCursor {
  return {
    agentId: scope.agentId,
    generation,
    lastSeq: -1,
    sessionId: scope.sessionId,
    version: RAW_TRANSCRIPT_CURSOR_VERSION,
  };
}

/** Host adapters validate limits before acquiring a database handle. */
export function normalizeRawDeltaLimits(limits: SessionTranscriptRawDeltaLimits) {
  const maxEvents = normalizeVisibleMessageLimit(
    limits.maxEvents,
    DEFAULT_RAW_TRANSCRIPT_MAX_EVENTS,
    MAX_RAW_TRANSCRIPT_EVENTS,
    "maxEvents",
  );
  const maxBytes = normalizeVisibleMessageLimit(
    limits.maxBytes,
    DEFAULT_RAW_TRANSCRIPT_MAX_BYTES,
    MAX_RAW_TRANSCRIPT_BYTES,
    "maxBytes",
  );
  return { maxEvents, maxBytes };
}

/** Read inside the caller's validated projection snapshot on its exact connection. */
export function readTranscriptRawDeltaFromProjection(
  projection: CurrentTranscriptProjection,
  limits: SessionTranscriptRawDeltaLimits = {},
): SessionTranscriptRawDeltaResult {
  const { maxEvents, maxBytes } = normalizeRawDeltaLimits(limits);
  const beforeEventSeq = resolveSqliteSessionTranscriptReadFence({
    database: projection.database,
    ...projection.resolved,
  })?.beforeRawSeq;
  return readRawDeltaInTransaction(
    projection.database.db,
    projection.resolved,
    limits.cursor,
    maxEvents,
    maxBytes,
    beforeEventSeq,
    { generation: projection.generation, indexedSeq: projection.state.indexedSeq },
  );
}

/** The caller owns this synchronous snapshot and any already-captured frontier. */
export function readRawDeltaInTransaction(
  database: import("node:sqlite").DatabaseSync,
  scope: ResolvedTranscriptReadScope,
  encodedCursor: string | undefined,
  maxEvents: number,
  maxBytes: number,
  beforeEventSeq: number | undefined,
  snapshot?: { generation: string | undefined; indexedSeq: number },
): SessionTranscriptRawDeltaResult {
  const watermark = snapshot
    ? undefined
    : readSessionTranscriptHotWatermark({ db: database }, scope.sessionId);
  const generation = snapshot ? snapshot.generation : (watermark?.generation ?? undefined);
  if (generation === undefined) {
    return { kind: "missing" };
  }

  const initialCursor = bootstrapCursor(scope, generation);
  const reset = (
    reason: Extract<SessionTranscriptRawDeltaResult, { kind: "reset" }>["reason"],
  ) => ({
    kind: "reset" as const,
    cursor: encodeRawTranscriptCursor(initialCursor),
    reason,
  });
  const cursor =
    encodedCursor !== undefined ? parseRawTranscriptCursor(encodedCursor) : initialCursor;
  if (!cursor) {
    return reset("invalid_cursor");
  }
  if (cursor.agentId !== scope.agentId || cursor.sessionId !== scope.sessionId) {
    return reset("scope_mismatch");
  }
  if (cursor.generation !== generation) {
    return reset("generation_mismatch");
  }
  const db = getNodeSqliteKysely<Pick<DB, "transcript_events">>(database);
  const transcript = db.selectFrom("transcript_events").where("session_id", "=", scope.sessionId);
  const frontier = snapshot ? snapshot.indexedSeq : watermark?.maxSeq;
  const maxSeq = Math.min(
    sqliteNumber(frontier ?? -1),
    beforeEventSeq === undefined ? Number.POSITIVE_INFINITY : beforeEventSeq - 1,
  );
  if (cursor.lastSeq > maxSeq) {
    if (beforeEventSeq !== undefined) {
      throw new SessionTranscriptReadFenceError(
        "Transcript read cursor has crossed the current-turn admission fence",
      );
    }
    return reset("invalid_cursor");
  }

  let serializedBytes = 0;
  let selectedCount = 0;
  let lastSeq = cursor.lastSeq;
  let hasMore = false;
  let requiredBytes: number | undefined;
  if (lastSeq < maxSeq) {
    const metadataQuery = transcript
      .select([
        "seq",
        /* kysely-allow-raw: SQLite byte length avoids fetching or parsing excluded JSON. */
        sql<number>`${transcriptEventReadBytesSql()} + 1`.as("serialized_bytes"),
      ])
      .$if(beforeEventSeq !== undefined, (query) => query.where("seq", "<", beforeEventSeq!))
      .orderBy("seq", "asc");
    // Grow bulk reads to preserve full-page throughput while bounding an early byte rejection.
    for (let batchSize = 32; lastSeq < maxSeq; batchSize *= 2) {
      const limit = Math.min(batchSize, maxEvents + 1 - selectedCount);
      const metadata = executeSqliteQuerySync(
        database,
        metadataQuery.where("seq", ">", lastSeq).limit(limit),
      ).rows;
      for (const row of metadata) {
        const rowBytes = sqliteNumber(row.serialized_bytes);
        if (selectedCount >= maxEvents || serializedBytes + rowBytes > maxBytes) {
          hasMore = true;
          if (selectedCount === 0) {
            requiredBytes = rowBytes;
          }
          break;
        }
        serializedBytes += rowBytes;
        selectedCount += 1;
        lastSeq = sqliteNumber(row.seq);
      }
      if (hasMore || metadata.length < limit) {
        break;
      }
    }
  }
  const rows =
    selectedCount === 0
      ? []
      : executeSqliteQuerySync(
          database,
          transcript
            .select([transcriptEventJsonSql(database).as("event_json"), "seq"])
            .where("seq", ">", cursor.lastSeq)
            .where("seq", "<=", lastSeq)
            .orderBy("seq", "asc"),
        ).rows.map((row) => ({
          event: JSON.parse(row.event_json),
          seq: sqliteNumber(row.seq),
        }));
  const nextCursor = encodeRawTranscriptCursor({ ...cursor, lastSeq });
  return {
    kind: "page",
    cursor: nextCursor,
    events: rows,
    hasMore,
    ...(requiredBytes !== undefined ? { requiredBytes } : {}),
    serializedBytes,
  };
}
