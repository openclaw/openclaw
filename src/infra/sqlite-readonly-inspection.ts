import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { sqlitePrimaryResultCode } from "./sqlite-error-diagnostics.js";
import {
  isSqliteReadOnlyError,
  readSourceJournalMode,
  readSourceSidecars,
  requiresPrivateRollbackRecovery,
  SqliteSourceChangedError,
} from "./sqlite-readonly-location.js";
import { readSqliteSchemaCookie } from "./sqlite-schema-contract.js";
import { withSqliteSourceReadDatabase } from "./sqlite-source-handle.js";

/**
 * Inspect in a dedicated child: closing a source in the caller can release its POSIX locks.
 * Empty/absent WAL has no frames to merge, so immutable metadata reads need no SHM.
 * Nonempty WAL requires its read-only index or the private snapshot owner.
 */
export function tryInspectSqliteReadOnlyInProcess<T>(
  pathname: string,
  inspect: (database: DatabaseSync) => T,
  options: { allowClosedWal?: boolean; preserveSourceArtifacts?: boolean } = {},
): { value: T } | undefined {
  const canonicalPath = fs.realpathSync.native(pathname);
  let mode: ReturnType<typeof readSourceJournalMode>;
  try {
    mode = readSourceJournalMode(canonicalPath);
  } catch (error) {
    if (error instanceof SqliteSourceChangedError) {
      return undefined;
    }
    throw error;
  }
  const sidecars = readSourceSidecars(canonicalPath);
  const preserve = options.preserveSourceArtifacts === true;
  const immutable =
    preserve &&
    mode === "wal" &&
    (fs.statSync(`${canonicalPath}-wal`, { throwIfNoEntry: false })?.size ?? 0) === 0 &&
    (fs.statSync(`${canonicalPath}-journal`, { throwIfNoEntry: false })?.size ?? 0) === 0;
  const closedWal =
    !preserve && options.allowClosedWal && !sidecars.wal && !sidecars.shm && !sidecars.journal;
  if (
    mode === "empty" ||
    (mode === "wal" && !(sidecars.wal && sidecars.shm) && !closedWal && !immutable) ||
    (preserve && !immutable && (mode !== "wal" || sidecars.journal))
  ) {
    return undefined;
  }
  const read = (database: DatabaseSync) => {
    try {
      // sqlite-allow-raw -- SQLite connection policy and deferred read admission, not a row query.
      database.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF; BEGIN;");
      // sqlite-allow-raw -- Stepping this SQLite pragma pins the schema read snapshot.
      database.prepare("PRAGMA schema_version;").get();
    } catch (error) {
      // Only changed WAL state or private rollback recovery can make a
      // snapshot useful. Preserve busy/I/O failures without a second attempt.
      let currentMode: ReturnType<typeof readSourceJournalMode>;
      try {
        currentMode = readSourceJournalMode(canonicalPath);
      } catch (inspectionError) {
        if (inspectionError instanceof SqliteSourceChangedError) {
          return undefined;
        }
        throw inspectionError;
      }
      const currentSidecars = readSourceSidecars(canonicalPath);
      if (
        (currentMode === "wal" && !(currentSidecars.wal && currentSidecars.shm)) ||
        (currentMode === "rollback" && currentSidecars.journal && isSqliteReadOnlyError(error)) ||
        // A read-only index SQLite cannot use falls back to the private snapshot.
        (preserve && isSqliteReadOnlyError(error))
      ) {
        return undefined;
      }
      throw error;
    }
    const value = inspect(database);
    // sqlite-allow-raw -- End the read-only snapshot without committing any source changes.
    database.exec("ROLLBACK;");
    return { value };
  };
  try {
    return withSqliteSourceReadDatabase(canonicalPath, "source", read, {
      view: immutable ? "immutable" : preserve ? "readonly-shm" : undefined,
    });
  } catch (error) {
    // The read-only index cannot be opened once the last connection closed and removed the
    // WAL family, and a new owner may already have recreated it, so the family is no
    // evidence. The private snapshot owner rereads the source and reports any lasting
    // open failure itself; a fallback never admits on its own.
    if (preserve && isSqliteCantOpenError(error)) {
      return undefined;
    }
    throw error;
  }
}

const SQLITE_CANTOPEN_RESULT_CODE = 14;

function isSqliteCantOpenError(error: unknown): boolean {
  return sqlitePrimaryResultCode(error) === SQLITE_CANTOPEN_RESULT_CODE;
}

/** The isolated reader lets SQLite distinguish a hot journal from harmless residue. */
export function requiresSqliteRollbackRecoveryInProcess(pathname: string): boolean {
  return withSqliteSourceReadDatabase(pathname, "source", (database) => {
    try {
      readSqliteSchemaCookie(database);
      return false;
    } catch (error) {
      if (!requiresPrivateRollbackRecovery(pathname, error)) {
        throw error;
      }
      return true;
    }
  });
}
