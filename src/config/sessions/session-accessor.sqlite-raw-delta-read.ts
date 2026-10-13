import { sql } from "kysely";
import { getNodeSqliteKysely, executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptRawDeltaResult,
} from "./session-accessor.sqlite-contract.js";
import type { CurrentTranscriptProjection } from "./session-accessor.sqlite-projection-read.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import { readSessionTranscriptHotWatermark } from "./session-accessor.sqlite-transcript-watermark-read.js";
import {
  bootstrapRawTranscriptCursor,
  encodeRawTranscriptCursor,
  normalizeRawDeltaLimits,
  parseRawTranscriptCursor,
} from "./session-transcript-raw-cursor.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

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

  const initialCursor = bootstrapRawTranscriptCursor(scope, generation);
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
