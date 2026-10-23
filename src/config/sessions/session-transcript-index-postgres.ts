import { sql } from "kysely";
import { getNodeSqliteKysely, prepareSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import {
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  withPostgresSessionTranscriptFtsRows,
  type SessionTranscriptFtsSourceRow,
} from "./session-transcript-fts.js";
import type {
  SessionTranscriptProjectionState,
  TranscriptIndexEntry,
} from "./session-transcript-projection-append.js";
import type { PreparedSessionTranscriptProjection } from "./session-transcript-projection-rebuild.js";
import { TRANSCRIPT_INSERT_BATCH_SIZE } from "./transcript-payload.js";

/** Writes each bounded PG projection chunk within the caller's existing transaction. */
export function createPostgresProjectionFlusher(db: EngineConnection, sessionId: string) {
  type Chunk = {
    activeRows: PreparedSessionTranscriptProjection["activeRows"];
    ftsRows: TranscriptIndexEntry[];
    watermark?: SessionTranscriptProjectionState & { updatedAt: number };
  };
  const kysely =
    getNodeSqliteKysely<
      Pick<DB, "session_transcript_active_events" | "session_transcript_index_state">
    >(db);
  const prepare = (
    activeCount: number,
    ftsCount: number,
    watermarkMode: "none" | "insert" | "update",
  ) =>
    prepareSqliteQuerySync<Chunk>(db, (parameter) => {
      const query =
        ftsCount > 0
          ? withPostgresSessionTranscriptFtsRows(
              db,
              sessionId,
              /* kysely-allow-raw: Bounded prepared FTS rows share the existing allocation owner. */
              sql<SessionTranscriptFtsSourceRow>`(values ${sql.join(
                Array.from(
                  { length: ftsCount },
                  (_, index) =>
                    sql`(${sql.lit(index)}, ${parameter((chunk) => chunk.ftsRows[index]!.messageId)}, ${parameter((chunk) => chunk.ftsRows[index]!.text)}, ${parameter((chunk) => chunk.ftsRows[index]!.role)}, ${parameter((chunk) => chunk.ftsRows[index]!.timestamp)})`,
                ),
              )})`,
            )
          : kysely;
      const withActive =
        activeCount > 0
          ? query.with("projection_active", () =>
              kysely
                .insertInto("session_transcript_active_events")
                .values(
                  Array.from({ length: activeCount }, (_, index) => ({
                    session_id: sessionId,
                    active_position: parameter((chunk) => chunk.activeRows[index]!.activePosition),
                    context_eligible: parameter(
                      (chunk) => chunk.activeRows[index]!.contextEligible,
                    ),
                    event_seq: parameter((chunk) => chunk.activeRows[index]!.eventSeq),
                    message_position: parameter(
                      (chunk) => chunk.activeRows[index]!.messagePosition,
                    ),
                  })),
                )
                .returning("event_seq"),
            )
          : query;
      const withWatermark =
        watermarkMode !== "none"
          ? withActive.with("projection_watermark", () => {
              const values = {
                active_event_count: parameter((chunk) => chunk.watermark!.activeEventCount),
                active_message_count: parameter((chunk) => chunk.watermark!.activeMessageCount),
                indexed_seq: parameter((chunk) => chunk.watermark!.indexedSeq),
                leaf_event_id: parameter((chunk) => chunk.watermark!.leafEventId),
                needs_rebuild: parameter((chunk) => (chunk.watermark!.needsRebuild ? 1 : 0)),
                updated_at: parameter((chunk) => chunk.watermark!.updatedAt),
              };
              return watermarkMode === "update"
                ? kysely
                    .updateTable("session_transcript_index_state")
                    .set(values)
                    .where("session_id", "=", sessionId)
                    .returning("session_id")
                : kysely
                    .insertInto("session_transcript_index_state")
                    .values({ session_id: sessionId, ...values })
                    .onConflict((conflict) => conflict.column("session_id").doUpdateSet(values))
                    .returning("session_id");
            })
          : withActive;
      // All writes target distinct tables and use prepared values. Only FTS content
      // depends on a sibling write, through the allocation owner's RETURNING rows.
      return withWatermark.selectNoFrom(sql.lit(1).as("written"));
    });
  const writes = new Map<string, ReturnType<typeof prepare>>();
  return (pending: Chunk, persisted: boolean) => {
    const count = Math.max(
      pending.activeRows.length,
      pending.ftsRows.length,
      pending.watermark ? 1 : 0,
    );
    for (let offset = 0; offset < count; offset += TRANSCRIPT_INSERT_BATCH_SIZE) {
      const chunk = {
        activeRows: pending.activeRows.slice(offset, offset + TRANSCRIPT_INSERT_BATCH_SIZE),
        ftsRows: pending.ftsRows.slice(offset, offset + TRANSCRIPT_INSERT_BATCH_SIZE),
        watermark: offset + TRANSCRIPT_INSERT_BATCH_SIZE >= count ? pending.watermark : undefined,
      };
      const mode = chunk.watermark ? (persisted ? "update" : "insert") : "none";
      const key = `${chunk.activeRows.length}:${chunk.ftsRows.length}:${mode}`;
      let write = writes.get(key);
      if (!write) {
        write = prepare(chunk.activeRows.length, chunk.ftsRows.length, mode);
        writes.set(key, write);
      }
      withSqliteDatabaseWriteScope(db, [sqliteSessionIdWriteScope(sessionId)], () => write(chunk));
    }
  };
}
