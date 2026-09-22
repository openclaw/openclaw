import { toUSVString } from "node:util";
import { sql } from "kysely";
import { executeSqliteQuerySync, prepareSqliteQuerySync } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptStats } from "./session-accessor.sqlite-contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

function sqliteTranscriptJsonlByteSize() {
  // octet_length reads column metadata; casting to BLOB loads every overflow payload first.
  return /* kysely-allow-raw: JSONL size includes event bytes plus newline separators. */ sql<number>`COALESCE(SUM(OCTET_LENGTH(event_json)), 0)
    + CASE WHEN COUNT(*) > 0 THEN COUNT(*) - 1 ELSE 0 END`.as("size_bytes");
}

function createTranscriptStatsQuery(database: Pick<OpenClawAgentDatabase, "db">) {
  const db = getSessionKysely(database.db);
  return prepareSqliteQuerySync<
    string,
    {
      event_count: number;
      max_seq: number | null;
      size_bytes: number;
      cold_event_count: number | null;
      cold_last_seq: number | null;
      cold_raw_bytes: number | null;
      transcript_observed_at: number | null;
      transcript_updated_at: number | null;
    }
  >(database.db, (parameter) =>
    db
      .selectFrom(
        db
          .selectFrom("transcript_events")
          .select((eb) => [
            eb.fn.count<number>("seq").as("event_count"),
            eb.fn.max<number>("seq").as("max_seq"),
            sqliteTranscriptJsonlByteSize(),
          ])
          .where(
            "session_id",
            "=",
            parameter((sessionId) => sessionId),
          )
          .as("events"),
      )
      .leftJoin("session_transcript_cold_archives as cold", (join) =>
        join.on(
          "cold.session_id",
          "=",
          parameter((sessionId) => sessionId),
        ),
      )
      .leftJoin("session_windows as session", (join) =>
        join.on(
          "session.session_id",
          "=",
          parameter((sessionId) => sessionId),
        ),
      )
      .select([
        "events.event_count",
        "events.max_seq",
        "events.size_bytes",
        "cold.event_count as cold_event_count",
        "cold.last_seq as cold_last_seq",
        "cold.raw_bytes as cold_raw_bytes",
        "session.transcript_observed_at",
        "session.transcript_updated_at",
      ]),
  );
}

const transcriptStatsQueries = new WeakMap<
  OpenClawAgentDatabase["db"],
  ReturnType<typeof createTranscriptStatsQuery>
>();

/** Reads transcript freshness and byte size without materializing event rows. */
export function readTranscriptStatsFromDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
): SessionTranscriptStats {
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      let query = transcriptStatsQueries.get(database.db);
      if (!query) {
        query = createTranscriptStatsQuery(database);
        transcriptStatsQueries.set(database.db, query);
      }
      const row = query(sessionId).rows[0];
      return {
        eventCount: row?.cold_event_count ?? row?.event_count ?? 0,
        ...(row?.transcript_updated_at !== null && row?.transcript_updated_at !== undefined
          ? { lastMutationAtMs: row.transcript_updated_at }
          : {}),
        ...(row?.transcript_observed_at !== null && row?.transcript_observed_at !== undefined
          ? { lastObservedMutationAtMs: row.transcript_observed_at }
          : {}),
        maxSeq: row?.cold_last_seq ?? row?.max_seq ?? 0,
        sizeBytes: row?.cold_raw_bytes ?? row?.size_bytes ?? 0,
      };
    },
    { operationLabel: "session transcript stats" },
  );
}

function readTranscriptStatsChunkFromDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionIds: readonly string[],
): Map<string, SessionTranscriptStats> {
  const db = getSessionKysely(database.db);
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const stats = new Map<string, SessionTranscriptStats>(
        sessionIds.map((sessionId) => [sessionId, { eventCount: 0, maxSeq: 0, sizeBytes: 0 }]),
      );
      // Read each source independently: read-only diagnostics also report partial
      // stores whose raw or cold rows no longer have a session window.
      for (const row of executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select((eb) => [
            "session_id",
            eb.fn.count<number>("seq").as("event_count"),
            eb.fn.max<number>("seq").as("max_seq"),
            sqliteTranscriptJsonlByteSize(),
          ])
          .where("session_id", "in", sessionIds)
          .groupBy("session_id"),
      ).rows) {
        stats.set(row.session_id, {
          eventCount: row.event_count,
          maxSeq: row.max_seq ?? 0,
          sizeBytes: row.size_bytes,
        });
      }
      for (const row of executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_windows")
          .select(["session_id", "transcript_updated_at", "transcript_observed_at"])
          .where("session_id", "in", sessionIds),
      ).rows) {
        const value = stats.get(row.session_id)!;
        if (row.transcript_updated_at !== null) {
          value.lastMutationAtMs = row.transcript_updated_at;
        }
        if (row.transcript_observed_at !== null) {
          value.lastObservedMutationAtMs = row.transcript_observed_at;
        }
      }
      for (const row of executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_transcript_cold_archives")
          .select(["session_id", "event_count", "last_seq", "raw_bytes"])
          .where("session_id", "in", sessionIds),
      ).rows) {
        const value = stats.get(row.session_id)!;
        value.eventCount = row.event_count;
        value.maxSeq = row.last_seq;
        value.sizeBytes = row.raw_bytes;
      }
      return stats;
    },
    { operationLabel: "session transcript stats" },
  );
}

const SQLITE_TRANSCRIPT_STATS_POINT_QUERY_LIMIT = 10;
const SQLITE_TRANSCRIPT_STATS_QUERY_CHUNK_SIZE = 400;

/** Read ordered stats on one supplied connection, preserving duplicate and missing session IDs. */
export function readTranscriptStatsBatchFromDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionIds: readonly string[],
): SessionTranscriptStats[] {
  // Prepared point queries avoid three-query compilation on small batches.
  if (sessionIds.length <= SQLITE_TRANSCRIPT_STATS_POINT_QUERY_LIMIT) {
    return sessionIds.map((sessionId) => readTranscriptStatsFromDatabase(database, sessionId));
  }
  // Match node:sqlite's string binding before looking up rows by their stored ID.
  const uniqueIds = [...new Set(sessionIds.map((sessionId) => toUSVString(sessionId)))];
  const stats = new Map<string, SessionTranscriptStats>();
  for (
    let offset = 0;
    offset < uniqueIds.length;
    offset += SQLITE_TRANSCRIPT_STATS_QUERY_CHUNK_SIZE
  ) {
    const chunk = uniqueIds.slice(offset, offset + SQLITE_TRANSCRIPT_STATS_QUERY_CHUNK_SIZE);
    if (chunk.length <= SQLITE_TRANSCRIPT_STATS_POINT_QUERY_LIMIT) {
      for (const sessionId of chunk) {
        stats.set(sessionId, readTranscriptStatsFromDatabase(database, sessionId));
      }
    } else {
      for (const [sessionId, value] of readTranscriptStatsChunkFromDatabase(database, chunk)) {
        stats.set(sessionId, value);
      }
    }
  }
  return sessionIds.map((sessionId) => ({ ...stats.get(toUSVString(sessionId))! }));
}
