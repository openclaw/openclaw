export const WORKSPACE_QUIESCENCE_WINDOWS_LEASE_JS = String.raw`function withWindowsWorkspaceLease(databasePath, workspaceKey, run) {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_leases'").get()) {
      database.exec("CREATE TABLE IF NOT EXISTS workspace_leases (workspace_key TEXT PRIMARY KEY, lease_json TEXT NOT NULL)");
    }
    database
      .prepare("DELETE FROM workspace_leases WHERE json_extract(lease_json, '$.expiresAtMs') <= ?")
      .run(Date.now());
    const row = database
      .prepare("SELECT lease_json FROM workspace_leases WHERE workspace_key = ?")
      .get(workspaceKey);
    const next = run(row ? row.lease_json : null);
    if (next === null) {
      database.prepare("DELETE FROM workspace_leases WHERE workspace_key = ?").run(workspaceKey);
    } else if (next !== undefined) {
      database
        .prepare("INSERT INTO workspace_leases (workspace_key, lease_json) VALUES (?, ?) ON CONFLICT(workspace_key) DO UPDATE SET lease_json = excluded.lease_json")
        .run(workspaceKey, next);
    }
    database.exec("COMMIT");
    return next;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}`;
