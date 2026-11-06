import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { runWithSqliteCleanup, SqliteSnapshotCleanupError } from "../sqlite-lifecycle-errors.js";
import { tryInspectSqliteReadOnlyInProcess } from "../sqlite-readonly-inspection.js";
import { prepareSqliteReadOnlyCopyInProcess } from "../sqlite-readonly-location.js";
import { runSqliteReadOnlyWorkerSync } from "../sqlite-readonly-worker.js";
import { readEngineAnchor } from "./open.js";
import type { BackupEngine } from "./types.js";

export type { BackupEngine } from "./types.js";

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

/** Source opens and closes stay in a child to preserve the caller's live POSIX locks. */
export function readBackupEngine(sourcePath: string): BackupEngine {
  return runSqliteReadOnlyWorkerSync(sourcePath, undefined, "backup-engine");
}

/** Child-only: healthy sources need only the schema and anchor pages, never a full image. */
export async function readBackupEngineInProcess(sourcePath: string): Promise<BackupEngine> {
  const inspected = tryInspectSqliteReadOnlyInProcess(sourcePath, (db) =>
    readEngineAnchorIdentity(db, sourcePath),
  );
  if (inspected) {
    return inspected.value;
  }
  // Hot rollback journals and incomplete WAL families still recover on private bytes.
  const prepared = await prepareSqliteReadOnlyCopyInProcess(sourcePath);
  return runWithSqliteCleanup(
    {
      release() {
        if (!prepared.cleanup()) {
          throw new SqliteSnapshotCleanupError(
            `SQLite engine inspection cleanup failed: ${sourcePath}`,
          );
        }
      },
    },
    "SQLite engine inspection",
    () => readBackupEngineImage(prepared.location, sourcePath),
  );
}
