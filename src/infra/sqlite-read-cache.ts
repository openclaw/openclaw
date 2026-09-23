import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { readSqliteDataVersion, resolveSqliteFilesystemPath } from "./node-sqlite.js";
import { compareValidSemver } from "./semver.js";
import { isSqliteCorruptionError } from "./sqlite-error-diagnostics.js";

function readCacheToken(database: DatabaseSync, databasePath: string): string | undefined {
  if (database.isTransaction) {
    return undefined;
  }
  const dataVersion = readSqliteDataVersion(database);
  const wal = fs.statSync(`${databasePath}-wal`, { bigint: true, throwIfNoEntry: false });
  if (!wal || wal.size === 0n) {
    return `${dataVersion}:empty`;
  }
  const version = database /* sqlite-allow-raw -- Guard NOOP support on this SQLite connection. */
    .prepare("SELECT sqlite_version() AS version")
    .get()?.version;
  // Older SQLite interprets unknown checkpoint modes as PASSIVE, which writes.
  if (typeof version !== "string" || (compareValidSemver(version, "3.53.0") ?? -1) < 0) {
    return undefined;
  }
  const checkpoint =
    database /* sqlite-allow-raw -- Inspect committed WAL frames without checkpointing. */
      .prepare("PRAGMA main.wal_checkpoint(NOOP)")
      .get();
  const pageSize =
    database /* sqlite-allow-raw -- Derive the physical extent of committed WAL frames. */
      .prepare("PRAGMA main.page_size")
      .get()?.page_size;
  const frames = checkpoint?.log;
  if (
    checkpoint?.busy !== 0 ||
    typeof frames !== "number" ||
    !Number.isSafeInteger(frames) ||
    frames < 0 ||
    typeof pageSize !== "number" ||
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0 ||
    wal.size !== 32n + BigInt(frames) * (24n + BigInt(pageSize))
  ) {
    return undefined;
  }
  // WAL bytes precede commit publication. Unpublished or retained trailing
  // frames cannot prove that a later commit will change the file fingerprint.
  return `${dataVersion}:${frames}:${pageSize}`;
}

/** Bracket rows on their existing connection; no extra source descriptors or writes. */
export function prepareSqliteReadCache(
  database: DatabaseSync,
  databasePath: string,
): () => boolean {
  let before: string | undefined;
  try {
    const location = database.location();
    if (
      location &&
      resolveSqliteFilesystemPath(path.resolve(location)) ===
        resolveSqliteFilesystemPath(path.resolve(databasePath))
    ) {
      before = readCacheToken(database, databasePath);
    }
  } catch (error) {
    if (isSqliteCorruptionError(error)) {
      throw error;
    }
    // Cache admission is optional; the row read owns source errors.
  }
  return () => {
    if (before === undefined) {
      return false;
    }
    try {
      return readCacheToken(database, databasePath) === before;
    } catch (error) {
      if (isSqliteCorruptionError(error)) {
        throw error;
      }
      return false;
    }
  };
}
