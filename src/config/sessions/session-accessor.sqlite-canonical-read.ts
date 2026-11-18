import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import { canonicalSessionKeyMigrationRequiredError } from "./session-canonical-key.js";
import { attachSessionEntrySnapshots } from "./session-entry-snapshot-values.js";
import { sessionEntrySnapshotColumns } from "./session-entry-snapshots.js";
import type { SessionEntry } from "./types.js";

/** Doctor probes only the exact staged target and may replace a malformed partial row. */
export function readExactSessionEntryRowForCanonicalRepair(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
  options: { allowMalformedRowRepair?: boolean } = {},
) {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_nodes")
      .selectAll()
      .select(sessionEntrySnapshotColumns)
      .where("session_key", "=", sessionKey),
  );
  if (!row) {
    return undefined;
  }
  if (row.entry_json === "{}") {
    const retainedWindow = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_windows")
        .select("session_id")
        .where("session_id", "=", row.current_session_id)
        .where("session_key", "=", row.session_key),
    );
    if (retainedWindow) {
      return undefined;
    }
  }
  const parsedEntry = parseSessionEntryJson(row);
  if (!parsedEntry && !options.allowMalformedRowRepair) {
    throw canonicalSessionKeyMigrationRequiredError(
      `invalid persisted session row requires repair for ${sessionKey}`,
    );
  }
  const entry: SessionEntry = parsedEntry ?? {
    sessionId: row.current_session_id,
    updatedAt: row.updated_at,
  };
  if (!parsedEntry) {
    attachSessionEntrySnapshots(entry, row);
  }
  return { entry, row };
}
