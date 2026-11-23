import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { sqlitePrimaryResultCode } from "./sqlite-error-diagnostics.js";
import {
  isSqliteReadOnlyError,
  readSourceJournalMode,
  readSourceSidecars,
  SqliteSourceChangedError,
} from "./sqlite-readonly-location.js";
import { withSqliteSourceReadDatabase } from "./sqlite-source-handle.js";

/**
 * Inspect in a dedicated child: closing a source in the caller can release its POSIX locks.
 * `preserveSourceArtifacts` reads a complete WAL family through a read-only index without
 * changing database contents. SQLite may create an empty WAL if the last owner closes
 * before the read; unavailable families return undefined for the private snapshot owner.
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
  // Live runtime reads and certified clean closes permit empty WAL sidecars.
  // Acquire real read locks; never use immutable mode on a live path.
  const preserve = options.preserveSourceArtifacts === true;
  const closedWal =
    !preserve && options.allowClosedWal && !sidecars.wal && !sidecars.shm && !sidecars.journal;
  if (
    mode === "empty" ||
    (mode === "wal" && !(sidecars.wal && sidecars.shm) && !closedWal) ||
    (preserve && (mode !== "wal" || sidecars.journal))
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
    return withSqliteSourceReadDatabase(canonicalPath, "source", read, { readOnlyShm: preserve });
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
