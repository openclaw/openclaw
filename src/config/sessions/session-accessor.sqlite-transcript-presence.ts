import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";

/** Physical hot rows only; a retained cold archive does not satisfy this probe. */
export function hasStoredTranscriptEvents(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
): boolean {
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      database.db,
      getNodeSqliteKysely<DB>(database.db)
        .selectFrom("transcript_events")
        .select("seq")
        .where("session_id", "=", sessionId)
        .limit(1),
    ),
  );
}
