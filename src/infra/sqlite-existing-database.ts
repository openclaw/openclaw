import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { enableNodeSqliteKyselyStatementCache } from "./kysely-sync-cache-state.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { runWithSqliteBusyTimeout, setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "./sqlite-transaction.js";

export type ExistingSqliteTransaction = <T>(
  operation: () => T,
  options?: SqliteTransactionOptions,
) => T;

type ExistingSqliteReadOptions = {
  busyTimeoutMs: number;
  assertIdentity: () => void;
  validate: (database: DatabaseSync) => void;
};
type ExistingSqliteOperation<T> = (
  database: DatabaseSync,
  transact: ExistingSqliteTransaction,
) => T;
type RetainedReader = { database?: DatabaseSync };

/** Reuse only the handle, never a snapshot, validation result, or authority. */
export function createExistingSqliteRollbackReader(
  pathname: string,
  options: ExistingSqliteReadOptions,
) {
  const retained: RetainedReader = {};
  let disposed = false;
  const close = () => {
    const database = retained.database;
    retained.database = undefined;
    if (database?.isOpen) {
      database.close();
    }
  };
  return Object.assign(
    <T>(operation: ExistingSqliteOperation<T>): T => {
      if (disposed || retained.database?.isTransaction) {
        throw new Error("Existing SQLite reader is closed or already in use.");
      }
      try {
        return withExistingRollbackDatabase(
          pathname,
          { ...options, write: false },
          operation,
          retained,
        );
      } catch (error) {
        close();
        throw error;
      }
    },
    {
      [Symbol.dispose]() {
        disposed = true;
        close();
      },
    },
  );
}

/** Keep a SQLite-owned read lock until the existing writer has acquired its lock. */
export function withExistingSqliteRollbackDatabase<T>(
  pathname: string,
  options: ExistingSqliteReadOptions & { write: boolean },
  operation: ExistingSqliteOperation<T>,
): T {
  return withExistingRollbackDatabase(pathname, options, operation);
}

function withExistingRollbackDatabase<T>(
  pathname: string,
  options: ExistingSqliteReadOptions & { write: boolean },
  operation: ExistingSqliteOperation<T>,
  retained?: RetainedReader,
): T {
  options.assertIdentity();
  // SQLite may discard an orphan journal for a zero-page database. An existing
  // owner requires populated storage and must not perform that cleanup.
  if (fs.statSync(pathname).size === 0) {
    throw new Error("Existing SQLite storage is empty.");
  }
  const reader = retained?.database ?? openNodeSqliteDatabase(pathname, { readOnly: true });
  if (retained && !retained.database) {
    enableNodeSqliteKyselyStatementCache(reader);
    retained.database = reader;
  }
  let writer: DatabaseSync | undefined;
  let snapshotOpen = false;
  const releaseReader = () => {
    if (!reader.isOpen) {
      return;
    }
    try {
      // Bun's close_v2 can retain prepared statements until GC. End the native
      // snapshot explicitly so closing cannot leave its SHARED lock alive.
      if (snapshotOpen && reader.isTransaction) {
        reader.exec("PRAGMA locking_mode = NORMAL"); // sqlite-allow-raw -- Release locks even when snapshot validation failed.
        reader.exec("ROLLBACK"); // sqlite-allow-raw -- End our read-only snapshot before closing.
      }
      snapshotOpen = false;
    } finally {
      if (!retained) {
        reader.close();
      }
    }
  };
  try {
    options.assertIdentity();
    setSqliteBusyTimeout(reader, options.busyTimeoutMs);
    if (retained) {
      // A fresh connection cannot hide in-place damage behind cached pages or
      // schema, even if a non-SQLite writer leaves the change counters intact.
      // RESET disables schema writing, reloads schema and expires statements;
      // both pragmas affect connection caches only, never database contents.
      reader.exec("PRAGMA shrink_memory; PRAGMA writable_schema = RESET"); // sqlite-allow-raw -- Discard pager and schema authority between observations.
    }
    // Disable WAL shared-memory admission before the first pager read. A foreign
    // WAL database cannot acquire an exclusive writer lock through a read-only
    // connection, so SQLite refuses without creating WAL/SHM coordination files.
    // This is connection-local, not a journal-mode change or an immutable snapshot.
    reader.exec("PRAGMA locking_mode = EXCLUSIVE"); // sqlite-allow-raw -- Refuse foreign WAL without creating sidecars.
    reader.exec("BEGIN"); // sqlite-allow-raw -- Hold the read lock across writer admission.
    snapshotOpen = true;
    if (retained) {
      // Reused connections cache journal_mode until a pager read. Refresh the
      // header while EXCLUSIVE still prevents a newly foreign WAL from creating
      // sidecars; schema validation alone need not read the pager on every call.
      reader.prepare("PRAGMA schema_version").get(); // sqlite-allow-raw -- Refresh native pager state, not a cached schema decision.
    }
    // These stores use rollback journals. SQLite itself distinguishes a healthy
    // writer's journal from a hot journal; readOnly refuses hot-journal playback.
    const mode = reader.prepare("PRAGMA journal_mode").get()?.journal_mode; // sqlite-allow-raw -- Observe, never change, the native journaling mode.
    if (!["delete", "truncate", "persist"].includes(String(mode))) {
      throw new Error("Existing SQLite storage requires rollback journal mode.");
    }
    // Keep the snapshot open, but let ROLLBACK release its lock without waiting
    // for Bun to finalize retained statements after close_v2.
    reader.exec("PRAGMA locking_mode = NORMAL"); // sqlite-allow-raw -- Restore connection-local lock policy.
    options.validate(reader);
    options.assertIdentity();
    if (!options.write) {
      return operation(reader, () => {
        throw new Error("Read-only SQLite observation cannot admit a writer.");
      });
    }
    writer = openNodeSqliteDatabase(resolveExistingSqliteFileUri(pathname));
    options.assertIdentity();
    setSqliteBusyTimeout(writer, options.busyTimeoutMs);
    const database = writer;
    let admitted = false;
    return operation(database, (write, transactionOptions) => {
      if (admitted && !database.isTransaction) {
        throw new Error("Existing SQLite write admission has already settled.");
      }
      options.assertIdentity();
      // Waiting while our reader blocks another writer's commit would deadlock.
      // Try once, then release the snapshot on BUSY; no recovery is attempted.
      return runWithSqliteBusyTimeout(database, 0, (restore) =>
        runSqliteImmediateTransactionSync(
          database,
          () => {
            if (!admitted) {
              admitted = true;
              releaseReader();
            }
            restore();
            options.assertIdentity();
            return write();
          },
          transactionOptions,
        ),
      );
    });
  } finally {
    try {
      if (writer?.isOpen) {
        writer.close();
      }
    } finally {
      releaseReader();
    }
  }
}
