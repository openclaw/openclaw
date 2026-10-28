import type { DatabaseSync } from "node:sqlite";
import { getAdmittedSqliteSchemaFacts } from "./sqlite-schema-facts.js";

/** Runtime admission needs table presence, without loading the migration's history codecs. */
export function hasLegacyCronRunLogs(db: DatabaseSync): boolean {
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (schema) {
    return schema.tables.has("cron_run_logs");
  }
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cron_run_logs' LIMIT 1",
      )
      .get(),
  );
}
