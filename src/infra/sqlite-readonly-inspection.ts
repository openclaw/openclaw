import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  isSqliteReadOnlyError,
  readSourceJournalMode,
  readSourceSidecars,
  SqliteSourceChangedError,
} from "./sqlite-readonly-location.js";
import { withSqliteSourceHandle, withSqliteSourceReadDatabase } from "./sqlite-source-handle.js";

/** Inspect in a dedicated child: closing a source in the caller can release its POSIX locks. */
export function tryInspectSqliteReadOnlyInProcess<T>(
  pathname: string,
  inspect: (database: DatabaseSync) => T,
): { value: T } | undefined {
  return withSqliteSourceHandle(pathname, () => {
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
    // Keep byte-neutral private recovery for empty files, incomplete WAL state,
    // and rollback journals. These cannot always be attached read-only.
    if (
      mode === "empty" ||
      sidecars.journal ||
      (mode === "wal" && !(sidecars.wal && sidecars.shm))
    ) {
      return undefined;
    }
    return withSqliteSourceReadDatabase(canonicalPath, (database) => {
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
          (currentMode === "rollback" && currentSidecars.journal && isSqliteReadOnlyError(error))
        ) {
          return undefined;
        }
        throw error;
      }
      const value = inspect(database);
      // sqlite-allow-raw -- End the read-only snapshot without committing any source changes.
      database.exec("ROLLBACK;");
      return { value };
    });
  });
}
