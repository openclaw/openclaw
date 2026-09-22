// Transcript watermark reader: the (generation, max seq) token pair that
// validates transcript-derived caches (derived titles, branch summaries).
// Kept apart from the active-events reader so cache validation stays a
// dependency-light import for gateway callers.
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";

type WatermarkDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_windows"
  | "transcript_events"
  | "transcript_rewrite_watermarks"
  | "session_transcript_cold_archives"
>;

export type SessionTranscriptWatermark = {
  generation: string | null;
  maxSeq: number | null;
};

/** Reads hot append and rewrite tokens together for transcript-derived caches. */
export function readSessionTranscriptHotWatermark(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
): SessionTranscriptWatermark {
  const db = getNodeSqliteKysely<WatermarkDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectNoFrom((eb) => [
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
    ]),
  );
  return { generation: row?.generation ?? null, maxSeq: row?.max_seq ?? null };
}

/** Reads the append and rewrite tokens that validate transcript-derived caches. */
export function readSessionTranscriptWatermark(
  scope: SessionTranscriptReadScope,
): SessionTranscriptWatermark {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(
        database.db,
        () => {
          const watermark = readSessionTranscriptHotWatermark(database, resolved.sessionId);
          const cold = readSessionColdTranscript(database.db, resolved.sessionId);
          return { ...watermark, maxSeq: cold?.last_seq ?? watermark.maxSeq };
        },
        { databaseLabel: database.path, operationLabel: "session transcript watermark read" },
      ),
    toDatabaseOptions(resolved),
    { throwOnMissingTable: true },
  );
  return result.found ? result.value : { generation: null, maxSeq: null };
}
