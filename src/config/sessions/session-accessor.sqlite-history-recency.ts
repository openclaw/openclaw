import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import { isRecentSessionMaintenanceEntry } from "./store-maintenance-activity.js";

function* recentSessionHistoryIds(
  params: {
    database: Pick<OpenClawAgentDatabase, "db">;
    preserveRecentMs?: number | null;
  },
  sessionId?: string,
): IterableIterator<string> {
  if (params.preserveRecentMs == null) {
    return;
  }
  const db = getNodeSqliteKysely<
    Pick<OpenClawAgentKyselyDatabase, "session_nodes" | "session_windows">
  >(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_windows")
      .innerJoin("session_nodes", "session_nodes.session_key", "session_windows.session_key")
      .select([
        "session_nodes.current_session_id",
        "session_nodes.session_key",
        "session_nodes.updated_at",
        "session_nodes.entry_json",
        "session_windows.session_id",
      ])
      .$if(sessionId !== undefined, (query) =>
        query.where("session_windows.session_id", "=", sessionId!),
      ),
  ).rows;
  for (const row of rows) {
    const entry = parseSessionEntryJson(row);
    if (
      entry &&
      isRecentSessionMaintenanceEntry({
        key: row.session_key,
        entry,
        preserveRecentMs: params.preserveRecentMs,
      })
    ) {
      yield row.session_id;
    }
  }
}

export function collectRecentSessionHistoryIds(params: {
  database: Pick<OpenClawAgentDatabase, "db">;
  preserveRecentMs?: number | null;
}): Set<string> {
  return new Set(recentSessionHistoryIds(params));
}

export function isRecentHistoricalSessionId(params: {
  database: Pick<OpenClawAgentDatabase, "db">;
  preserveRecentMs?: number | null;
  sessionId: string;
}): boolean {
  return !recentSessionHistoryIds(params, params.sessionId).next().done;
}
