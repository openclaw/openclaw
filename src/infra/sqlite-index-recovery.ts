import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireDirectorySync, syncDirectorySync } from "./directory-durability.js";
import { hashFileDescriptorSync } from "./file-descriptor.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { repairSqliteIndexCorruption } from "./sqlite-index-schema.js";
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

/** Preserve damaged pages through the snapshot owner before a Doctor repair writes. */
export function backupDoctorSqliteRepair(
  pathname: string,
  repair: "index" | "session-window",
): string {
  // Closing a source descriptor here would release this process's SQLite locks on POSIX.
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
      `openclaw-${repair}-recovery-`,
    );
    const backupPath = path.join(directory, "database.sqlite");
    const expected = syncAndHash(prepared.location);
    fs.copyFileSync(prepared.location, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, 0o600);
    if (JSON.stringify(syncAndHash(backupPath)) !== JSON.stringify(expected)) {
      throw new Error(`SQLite ${repair} recovery backup verification failed: ${backupPath}`);
    }
    requireDirectorySync(syncDirectorySync(directory), "SQLite recovery directory");
    requireDirectorySync(syncDirectorySync(path.dirname(directory)), "SQLite recovery parent");
    return backupPath;
  } finally {
    prepared.cleanup();
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
        backupPath = backupDoctorSqliteRepair(pathname, "index");
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
