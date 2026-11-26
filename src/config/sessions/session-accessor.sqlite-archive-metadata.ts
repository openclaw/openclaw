import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";

type ArchiveDatabase = Pick<DB, "session_transcript_archives">;

export function listTranscriptArchivesFromDatabase(
  database: Pick<OpenClawAgentDatabase, "db" | "agentId">,
  logicalAgentId: string | undefined,
  selectors: readonly string[],
  archiveNames: readonly string[],
) {
  return readTranscriptArchiveRows(database, logicalAgentId, selectors, archiveNames, true);
}

/**
 * Archive identities without creation order. Each row stores archive_blob before
 * created_at, so reading or ordering by created_at walks the blob's overflow
 * pages (782 MB for 2.9k archives on one Gateway); identity columns precede it.
 */
export function listTranscriptArchiveIdentitiesFromDatabase(
  database: Pick<OpenClawAgentDatabase, "db" | "agentId">,
  archiveNames: readonly string[],
) {
  return readTranscriptArchiveRows(database, undefined, [], archiveNames, false).map(
    ({ createdAt: _unread, ...archive }) => archive,
  );
}

// One query owner keeps this native read path's SQL surface unchanged.
function readTranscriptArchiveRows(
  { db, agentId }: Pick<OpenClawAgentDatabase, "db" | "agentId">,
  logicalAgentId: string | undefined,
  selectors: readonly string[],
  archiveNames: readonly string[],
  ordered: boolean,
) {
  // Archive metadata is optional until the first archive write.
  if (!tableExists(db, "session_transcript_archives")) {
    return [];
  }
  const selected = sqliteStringSet(selectors);
  const query = getNodeSqliteKysely<ArchiveDatabase>(db)
    .selectFrom("session_transcript_archives")
    .select((expression) => [
      "archive_name as archiveName",
      "session_id as sessionId",
      "session_key as sessionKey",
      (ordered ? expression.ref("created_at") : expression.lit(0)).as("createdAt"),
    ])
    .$if(ordered, (ordering) => ordering.orderBy("created_at").orderBy("session_id"))
    .where((expression) =>
      expression.or([
        ...(selectors.length > 0
          ? [expression("session_id", "in", selected), expression("session_key", "in", selected)]
          : []),
        ...(archiveNames.length > 0
          ? [expression("archive_name", "in", sqliteStringSet(archiveNames))]
          : []),
      ]),
    );
  const rows = executeSqliteQuerySync(db, query).rows;
  return rows
    .map((row) =>
      Object.assign(row, { agentId: resolveAgentIdFromSessionKey(row.sessionKey, agentId) }),
    )
    .filter((row) => logicalAgentId === undefined || row.agentId === logicalAgentId);
}
