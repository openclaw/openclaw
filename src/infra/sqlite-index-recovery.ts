import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireDirectorySync, syncDirectorySync } from "./directory-durability.js";
import { hashFileDescriptorSync } from "./file-descriptor.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { repairSqliteIndexCorruption } from "./sqlite-index-corruption.js";
import { createPrivateSqliteTempDirectorySync } from "./sqlite-private-directory.js";
import { prepareSqliteReadOnlyLocationSync } from "./sqlite-snapshot-source.js";

function syncAndHash(pathname: string) {
  const descriptor = fs.openSync(pathname, "r+");
  try {
    fs.fsyncSync(descriptor);
    return hashFileDescriptorSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Doctor holds maintenance authority; the snapshot owner preserves the damaged image. */
export function repairDoctorSqliteIndexCorruption(
  database: DatabaseSync,
  pathname: string,
  options: { label: string; assertCurrent: () => void },
): string[] {
  let backupPath: string | undefined;
  let indexes: string[];
  try {
    indexes = repairSqliteIndexCorruption(database, pathname, {
      assertCurrent: options.assertCurrent,
      backup: () => {
        options.assertCurrent();
        // Snapshot in the existing child owner: closing a source descriptor here
        // would release this process's SQLite locks on POSIX.
        const prepared = prepareSqliteReadOnlyLocationSync(pathname);
        try {
          const snapshot = openNodeSqliteDatabase(prepared.location);
          try {
            snapshot.exec("PRAGMA journal_mode = DELETE;");
          } finally {
            snapshot.close();
          }
          const directory = createPrivateSqliteTempDirectorySync(
            path.dirname(pathname),
            "openclaw-index-recovery-",
          );
          const pendingPath = path.join(directory, "database.sqlite");
          const expected = syncAndHash(prepared.location);
          fs.copyFileSync(prepared.location, pendingPath, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(pendingPath, 0o600);
          if (JSON.stringify(syncAndHash(pendingPath)) !== JSON.stringify(expected)) {
            throw new Error(`SQLite index recovery backup verification failed: ${pendingPath}`);
          }
          requireDirectorySync(syncDirectorySync(directory), "SQLite index recovery directory");
          requireDirectorySync(
            syncDirectorySync(path.dirname(directory)),
            "SQLite index recovery parent",
          );
          backupPath = pendingPath;
        } finally {
          prepared.cleanup();
        }
        options.assertCurrent();
      },
    });
  } catch (cause) {
    const preserved = backupPath ? ` Preserved pre-repair database: ${backupPath}.` : "";
    throw new Error(
      `SQLite index repair refused for ${pathname}.${preserved} Preserve the database and its WAL; restore a verified backup or use SQLite recovery. ${String(cause)}`,
      { cause },
    );
  }
  return indexes.length > 0
    ? [
        `Saved pre-repair SQLite backup: ${backupPath}`,
        `Warning: Rebuilt corrupt ${options.label} SQLite indexes: ${indexes.join(", ")}. No table rows were removed.`,
      ]
    : [];
}
