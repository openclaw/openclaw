import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveSqliteFilesystemPath } from "./node-sqlite.js";
import { readSqliteDatabaseWriteRevision } from "./sqlite-database-admission.js";
import { isSqliteCorruptionError } from "./sqlite-error-diagnostics.js";
import { readSqliteNativeMutationRevision } from "./sqlite-schema-facts.js";

function readCacheToken(database: DatabaseSync): string | undefined {
  if (database.isTransaction) {
    return undefined;
  }
  const revision = readSqliteDatabaseWriteRevision(database);
  const local = readSqliteNativeMutationRevision(database);
  return revision === undefined || local === undefined ? undefined : `${revision}:${local}`;
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
      before = readCacheToken(database);
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
      return readCacheToken(database) === before;
    } catch (error) {
      if (isSqliteCorruptionError(error)) {
        throw error;
      }
      return false;
    }
  };
}
