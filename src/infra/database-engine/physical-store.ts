import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { prepareSqliteReadOnlyLocationSync } from "../sqlite-snapshot-source.js";
import { readEngineAnchor } from "./open.js";

export type BackupEngine =
  | { engine: "sqlite" }
  | { engine: "postgres"; storeId: string; namespace: string };

/** Reads an already captured private image without reacquiring its live source. */
export function readBackupEngineImage(imagePath: string, sourcePath: string): BackupEngine {
  using db = openNodeSqliteDatabase(imagePath, { readOnly: true });
  return readEngineAnchorIdentity(db, sourcePath);
}

export function readEngineAnchorIdentity(db: DatabaseSync, sourcePath: string): BackupEngine {
  const rows = readEngineAnchor(db);
  if (!rows) {
    return { engine: "sqlite" };
  }
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.engine !== "postgres" ||
    typeof row.store_id !== "string" ||
    typeof row.schema !== "string" ||
    !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(row.schema)
  ) {
    throw new Error(`Invalid PostgreSQL anchor: ${sourcePath}. Restore its matched backup.`);
  }
  return { engine: "postgres", storeId: row.store_id, namespace: row.schema };
}

/** Acquire the private image in a child so source descriptor closes preserve live POSIX locks. */
export function readBackupEngine(sourcePath: string): BackupEngine {
  const prepared = prepareSqliteReadOnlyLocationSync(sourcePath);
  try {
    return readBackupEngineImage(prepared.location, sourcePath);
  } finally {
    prepared.cleanup();
  }
}
