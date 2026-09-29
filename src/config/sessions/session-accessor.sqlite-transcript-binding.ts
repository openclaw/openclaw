import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { CurrentTranscriptProjection } from "./session-accessor.sqlite-projection-read.js";
import type { SessionHistoryTranscriptBinding } from "./session-history-types.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

export function readSessionTranscriptBindingFromProjection(
  projection: CurrentTranscriptProjection,
): SessionHistoryTranscriptBinding | undefined {
  resolveSqliteSessionTranscriptReadFence({
    database: projection.database,
    ...projection.resolved,
  });
  const { sessionId } = projection.resolved;
  const owner = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    getNodeSqliteKysely<Pick<DB, "session_windows">>(projection.database.db)
      .selectFrom("session_windows")
      .select("session_key")
      .where("session_id", "=", sessionId),
  );
  if (!owner) {
    return undefined;
  }
  return { sessionId, sessionKey: owner.session_key };
}
