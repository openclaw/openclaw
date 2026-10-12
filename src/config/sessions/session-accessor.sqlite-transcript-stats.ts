import { sql, type AliasableExpression } from "kysely";
import {
  createSqliteQueryCache,
  encodeSqliteStringSet,
  prepareSqliteQuerySync,
  sqliteStringSetEntries,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { chunkItems } from "../../utils/chunk-items.js";
import type { SessionTranscriptStats } from "./session-accessor.sqlite-contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";

type TranscriptStatsRow = Omit<
  SessionTranscriptStats,
  "lastMutationAtMs" | "lastObservedMutationAtMs"
> & {
  position: number;
  lastMutationAtMs: number | null;
  lastObservedMutationAtMs: number | null;
};

const transcriptStatsQuery = createSqliteQueryCache((database) => {
  const db = getSessionKysely(database);
  const prepare = (point: boolean) =>
    prepareSqliteQuerySync<readonly string[], TranscriptStatsRow>(database, (parameter) => {
      const id = parameter((ids) => ids[0]!);
      const requested = (): AliasableExpression<{ key: number; value: string | null }> =>
        point
          ? db.selectNoFrom([id.as("value"), sql.lit(0).as("key")])
          : sqliteStringSetEntries(parameter(encodeSqliteStringSet));
      // Requested IDs, not session windows, own the result: diagnostics also read orphan raw/cold rows.
      return db
        .selectFrom(requested().as("target"))
        .leftJoin(
          db
            .selectFrom("transcript_events")
            .select((eb) => [
              "session_id",
              eb.fn.count<number>("seq").as("event_count"),
              eb.fn.max<number>("seq").as("max_seq"),
              // kysely-allow-raw: JSONL byte size includes newline separators without decoding payloads.
              sql<number>`COALESCE(SUM(${transcriptEventReadBytesSql()}), 0) + COUNT(*) - 1`.as(
                "size_bytes",
              ),
            ])
            .$call((query) =>
              point
                ? query.where("session_id", "=", id)
                : query
                    .where(
                      "session_id",
                      "in",
                      db.selectFrom(requested().as("ids")).select("ids.value"),
                    )
                    .groupBy("session_id"),
            )
            .as("events"),
          "events.session_id",
          "target.value",
        )
        .leftJoin("session_transcript_cold_archives as cold", "cold.session_id", "target.value")
        .leftJoin("session_windows as session", "session.session_id", "target.value")
        .where((eb) =>
          eb.or([
            eb("events.session_id", "is not", null),
            eb("cold.session_id", "is not", null),
            eb("session.session_id", "is not", null),
          ]),
        )
        .select((eb) => [
          "target.key as position",
          eb.fn.coalesce("cold.event_count", "events.event_count", eb.val(0)).as("eventCount"),
          eb.fn.coalesce("cold.last_seq", "events.max_seq", eb.val(0)).as("maxSeq"),
          eb.fn.coalesce("cold.raw_bytes", "events.size_bytes", eb.val(0)).as("sizeBytes"),
          "session.transcript_observed_at as lastObservedMutationAtMs",
          "session.transcript_updated_at as lastMutationAtMs",
        ]);
    });
  return { point: prepare(true), batch: prepare(false) };
});

/** Read ordered stats in bounded statements, preserving duplicate and missing session IDs. */
export function readTranscriptStatsBatchFromDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionIds: readonly string[],
): SessionTranscriptStats[] {
  const queries = transcriptStatsQuery(database.db);
  // Keep cheap indexed point reads for small requests; both shapes share projection and decoding.
  const point = sessionIds.length <= 10;
  const read = point ? queries.point : queries.batch;
  return chunkItems(sessionIds, point ? 1 : 400).flatMap((chunk) => {
    const rows = new Map(read(chunk).rows.map((row) => [row.position, row]));
    return chunk.map((_, position) => {
      const row = rows.get(position);
      const stats: SessionTranscriptStats = {
        eventCount: row?.eventCount ?? 0,
        maxSeq: row?.maxSeq ?? 0,
        sizeBytes: row?.sizeBytes ?? 0,
      };
      if (row?.lastMutationAtMs != null) {
        stats.lastMutationAtMs = row.lastMutationAtMs;
      }
      if (row?.lastObservedMutationAtMs != null) {
        stats.lastObservedMutationAtMs = row.lastObservedMutationAtMs;
      }
      return stats;
    });
  });
}

/** Reads transcript freshness and byte size without materializing event rows. */
export function readTranscriptStatsFromDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
): SessionTranscriptStats {
  return readTranscriptStatsBatchFromDatabase(database, [sessionId])[0]!;
}
