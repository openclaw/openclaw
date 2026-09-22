import type { DatabaseSync } from "node:sqlite";
import { getNodeSqliteKysely, prepareSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";

type WatermarkDatabase = Pick<DB, "transcript_events" | "transcript_rewrite_watermarks">;

export type SessionTranscriptWatermark = {
  generation: string | null;
  maxSeq: number | null;
};

function prepareHotWatermarkQuery(database: DatabaseSync) {
  const db = getNodeSqliteKysely<WatermarkDatabase>(database);
  return prepareSqliteQueryTakeFirstSync<
    string,
    { generation: string | null; max_seq: number | null }
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
    ]);
  });
}

// Retain compiled SQL per native handle; the shared executor still owns statements
// and reads current rows with fresh bindings on every call.
const hotWatermarkQueries = new WeakMap<
  DatabaseSync,
  ReturnType<typeof prepareHotWatermarkQuery>
>();

/** Reads hot append and rewrite tokens together on the caller's admitted connection. */
export function readSessionTranscriptHotWatermark(
  database: { db: DatabaseSync },
  sessionId: string,
): SessionTranscriptWatermark {
  let query = hotWatermarkQueries.get(database.db);
  if (!query) {
    query = prepareHotWatermarkQuery(database.db);
    hotWatermarkQueries.set(database.db, query);
  }
  const row = query(sessionId);
  return { generation: row?.generation ?? null, maxSeq: row?.max_seq ?? null };
}
