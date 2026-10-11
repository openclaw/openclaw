// Transcript watermark reader: the (generation, max seq) token pair that
// validates transcript-derived caches (derived titles, branch summaries).
// Kept apart from the active-events reader so cache validation stays a
// dependency-light import for gateway callers.
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptWatermark } from "./session-accessor.sqlite-transcript-watermark-read.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";

const retainedWatermarkQuery = createSqliteQueryCache((database) => {
  const db = getNodeSqliteKysely<DB>(database);
  return prepareSqliteQueryTakeFirstSync<
    string,
    { generation: string | null; max_seq: number | null }
  >(database, (parameter) => {
    const sessionId = parameter((value) => value);
    return db.selectNoFrom((eb) => [
      eb.fn
        .coalesce(
          eb
            .selectFrom("session_transcript_cold_archives")
            .select("last_seq")
            .where("session_id", "=", sessionId),
          eb
            .selectFrom("transcript_events")
            .select((inner) => inner.fn.max<number>("seq").as("max_seq"))
            .where("session_id", "=", sessionId),
        )
        .as("max_seq"),
      eb
        .selectFrom("transcript_rewrite_watermarks")
        .select("generation")
        .where("session_id", "=", sessionId)
        .as("generation"),
    ]);
  });
});

/** Read hot generation and retained cold position together on the admitted snapshot. */
export function readSessionTranscriptWatermarkInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  sessionId: string,
): SessionTranscriptWatermark {
  const actor = readSessionActorTransactionState(database, { sessionId });
  if (actor) {
    return { ...actor.hot.transcript.watermark };
  }
  const row = retainedWatermarkQuery(database.db)(sessionId);
  return { generation: row?.generation ?? null, maxSeq: row?.max_seq ?? null };
}

/** Reads the append and rewrite tokens that validate transcript-derived caches. */
export function readSessionTranscriptWatermark(
  scope: SessionTranscriptReadScope,
): SessionTranscriptWatermark {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => readSessionTranscriptWatermarkInDatabase(database, resolved.sessionId),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : { generation: null, maxSeq: null };
}
