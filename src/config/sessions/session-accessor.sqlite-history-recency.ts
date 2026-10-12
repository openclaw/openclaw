import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import { isRecentSessionMaintenanceEntry } from "./store-maintenance-activity.js";

export function collectRecentSessionHistoryIds(params: {
  database: Pick<OpenClawAgentDatabase, "db">;
  preserveRecentMs?: number | null;
}): Set<string> {
  if (params.preserveRecentMs == null) {
    return new Set();
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
      ]),
  ).rows;
  return new Set(
    rows.flatMap((row) => {
      const entry = parseSessionEntryJson(row);
      return entry &&
        isRecentSessionMaintenanceEntry({
          key: row.session_key,
          entry,
          preserveRecentMs: params.preserveRecentMs,
        })
        ? [row.session_id]
        : [];
    }),
  );
}

export function isRecentHistoricalSessionId(params: {
  database: Pick<OpenClawAgentDatabase, "db">;
  preserveRecentMs?: number | null;
  sessionId: string;
}): boolean {
  if (params.preserveRecentMs == null) {
    return false;
  }
  const db = getNodeSqliteKysely<
    Pick<OpenClawAgentKyselyDatabase, "session_nodes" | "session_windows">
  >(params.database.db);
  const row = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_windows")
      .innerJoin("session_nodes", "session_nodes.session_key", "session_windows.session_key")
      .select([
        "session_nodes.current_session_id",
        "session_nodes.entry_json",
        "session_nodes.session_key",
        "session_nodes.updated_at",
      ])
      .where("session_windows.session_id", "=", params.sessionId),
  ).rows[0];
  if (!row) {
    return false;
  }
  const entry = parseSessionEntryJson(row);
  return Boolean(
    entry &&
    isRecentSessionMaintenanceEntry({
      key: row.session_key,
      entry,
      preserveRecentMs: params.preserveRecentMs,
    }),
  );
}
