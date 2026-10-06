import type { DatabaseSync } from "node:sqlite";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { SessionTranscriptWatermark } from "./session-history-read.types.js";

export type { SessionTranscriptWatermark } from "./session-history-read.types.js";

type WatermarkDatabase = Pick<
  DB,
  "transcript_events" | "transcript_rewrite_watermarks" | "session_transcript_cold_archives"
>;

// Retain compiled SQL per native handle; the shared executor still owns statements
// and reads current rows with fresh bindings on every call.
function prepareWatermarkQuery(database: DatabaseSync, includeCold: boolean) {
  const db = getNodeSqliteKysely<WatermarkDatabase>(database);
  return prepareSqliteQueryTakeFirstSync<
    string,
    { generation: string | null; max_seq: number | null }
  >(database, (parameter) => {
    const sessionId = parameter((value) => value);
    return db.selectNoFrom((eb) => {
      const hotMax = eb
        .selectFrom("transcript_events")
        .select((inner) => inner.fn.max<number>("seq").as("max_seq"))
        .where("session_id", "=", sessionId);
      const maxSeq = includeCold
        ? eb.fn.coalesce(
            eb
              .selectFrom("session_transcript_cold_archives")
              .select("last_seq")
              .where("session_id", "=", sessionId),
            hotMax,
          )
        : hotMax;
      return [
        maxSeq.as("max_seq"),
        eb
          .selectFrom("transcript_rewrite_watermarks")
          .select("generation")
          .where("session_id", "=", sessionId)
          .as("generation"),
      ];
    });
  });
}

const hotWatermarkQuery = createSqliteQueryCache((database) =>
  prepareWatermarkQuery(database, false),
);
const retainedWatermarkQuery = createSqliteQueryCache((database) =>
  prepareWatermarkQuery(database, true),
);

/** Reads hot append and rewrite tokens together on the caller's admitted connection. */
export function readSessionTranscriptHotWatermark(
  database: { db: DatabaseSync },
  sessionId: string,
): SessionTranscriptWatermark {
  const row = hotWatermarkQuery(database.db)(sessionId);
  return { generation: row?.generation ?? null, maxSeq: row?.max_seq ?? null };
}

/** Read hot generation and retained cold position together on the admitted snapshot. */
export function readSessionTranscriptWatermarkInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  sessionId: string,
): SessionTranscriptWatermark {
  const row = retainedWatermarkQuery(database.db)(sessionId);
  return { generation: row?.generation ?? null, maxSeq: row?.max_seq ?? null };
}
