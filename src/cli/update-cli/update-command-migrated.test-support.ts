import { DatabaseSync } from "node:sqlite";

// Inspect candidate-owned rows without invoking the retained runtime's older
// schema guards; every observation closes its own read-only connection.
export function readMigratedUpdateRunRow(databasePath: string, runId: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT * FROM update_runs WHERE run_id = ?").get(runId);
  } finally {
    database.close();
  }
}
