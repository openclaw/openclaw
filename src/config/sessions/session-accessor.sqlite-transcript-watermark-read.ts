import type { DatabaseSync } from "node:sqlite";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import type { SessionTranscriptWatermark } from "./session-history-read.types.js";

export type { SessionTranscriptWatermark } from "./session-history-read.types.js";

type WatermarkDatabase = Pick<
  DB,
  "transcript_events" | "transcript_rewrite_watermarks" | "session_transcript_cold_archives"
>;

// Retain compiled SQL per native handle; the shared executor still owns statements
// and reads current rows with fresh bindings on every call.
const hotWatermarkQuery = createSqliteQueryCache((database) => {
  const db = getNodeSqliteKysely<WatermarkDatabase>(database);
  return prepareSqliteQueryTakeFirstSync<
    string,
    { generation: string | null; max_seq: number | null; is_cold: number }
  >(database, (parameter) => {
    const sessionId = parameter((value) => value);
    return db.selectNoFrom((eb) => [
      eb
        .selectFrom("transcript_events")
        .select((inner) => inner.fn.max<number>("seq").as("max_seq"))
        .where("session_id", "=", sessionId)
        .as("max_seq"),
      eb
        .selectFrom("transcript_rewrite_watermarks")
        .select("generation")
        .where("session_id", "=", sessionId)
        .as("generation"),
      eb
        .exists(
          eb
            .selectFrom("session_transcript_cold_archives")
            .select("session_id")
            .where("session_id", "=", sessionId),
        )
        .as("is_cold"),
    ]);
  });
});

/** Reads hot append and rewrite tokens together on the caller's admitted connection. */
export function readSessionTranscriptHotWatermark(
  database: { db: DatabaseSync },
  sessionId: string,
  options: { requireHot?: boolean } = {},
): SessionTranscriptWatermark {
  const row = hotWatermarkQuery(database.db)(sessionId);
  if (options.requireHot && row?.is_cold) {
    throw new SessionTranscriptColdError(sessionId);
  }
  return { generation: row?.generation ?? null, maxSeq: row?.max_seq ?? null };
}
