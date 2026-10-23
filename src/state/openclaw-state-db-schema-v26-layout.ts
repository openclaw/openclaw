import type { DatabaseSync } from "node:sqlite";
import { migrateSqliteTableWithoutRowid } from "./sqlite-table-layout-migration.js";

/** Historical admission compares the physical layout installed before v26. */
export function withLegacyStateHeadLayout(schema: string): string {
  return schema.replace(
    /(CREATE TABLE IF NOT EXISTS session_state_heads \([\s\S]*?\n\) STRICT), WITHOUT ROWID;/u,
    "$1;",
  );
}

export function migrateSessionStateHeadLayoutV26(
  db: DatabaseSync,
  previousVersion: number,
): boolean {
  return previousVersion < 26 && migrateSqliteTableWithoutRowid(db, "session_state_heads");
}
