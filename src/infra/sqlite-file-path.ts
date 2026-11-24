import { basename } from "node:path";
import { isTransientSqliteBackupPath } from "./backup-volatile-filter.js";

/** Recognize database files and their lock-bearing SQLite companions without opening them. */
export function isSqliteFilePath(filePath: string): boolean {
  return (
    /\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/i.test(basename(filePath)) ||
    isTransientSqliteBackupPath(filePath)
  );
}
