import {
  createSqliteQueryCache,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope-helpers.js";
import { readTranscriptMutationStateInTransaction } from "./session-accessor.sqlite-transcript-state.js";

// Cache SQL by native handle, never session facts or native statements.
const transcriptPresenceQuery = createSqliteQueryCache((database: EngineConnection) => {
  const db = getSessionKysely(database);
  // Archive and restore move events atomically; both stores must share one statement snapshot.
  // A cold descriptor guarantees a nonempty transcript, even when its archive needs repair.
  return prepareSqliteQueryTakeFirstSync<string, { session_id: string }>(database, (parameter) => {
    const sessionId = parameter((value) => value);
    return db
      .selectFrom("transcript_events")
      .select("session_id")
      .where("session_id", "=", sessionId)
      .unionAll(
        db
          .selectFrom("session_transcript_cold_archives")
          .select("session_id")
          .where("session_id", "=", sessionId),
      )
      .limit(1);
  });
});

/** Physical presence and freshness share the caller's read transaction; neither scans events. */
export function readSessionTranscriptMetadataInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
) {
  return {
    present: Boolean(transcriptPresenceQuery(database.db)(sessionId)),
    ...readTranscriptMutationStateInTransaction(database, sessionId),
  };
}
