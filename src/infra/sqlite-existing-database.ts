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
  validate?: (database: DatabaseSync) => void;
};
type ExistingSqliteOperation<T> = (
  database: DatabaseSync,
  transact: ExistingSqliteTransaction,
) => T;
type RetainedReader = { database?: DatabaseSync };

/** Reuse an admitted handle; every operation still owns its read snapshot. */
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
        return withExistingSqliteRollbackDatabase(
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
  retained?: RetainedReader,
): T {
  options.assertIdentity();
  // SQLite may discard an orphan journal for a zero-page database. An existing
  // owner requires populated storage and must not perform that cleanup.
  if (fs.statSync(pathname).size === 0) {
    throw new Error("Existing SQLite storage is empty.");
  }
  const existing = retained?.database;
  const reader = existing ?? openNodeSqliteDatabase(pathname, { readOnly: true });
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
    if (!existing) {
      setSqliteBusyTimeout(reader, options.busyTimeoutMs);
    }
    // Disable WAL shared-memory admission before the first pager read. A foreign
    // WAL database cannot acquire an exclusive writer lock through a read-only
    // connection, so SQLite refuses without creating WAL/SHM coordination files.
    // This is connection-local, not a journal-mode change or an immutable snapshot.
    reader.exec("PRAGMA locking_mode = EXCLUSIVE"); // sqlite-allow-raw -- Refuse foreign WAL without creating sidecars.
    reader.exec("BEGIN"); // sqlite-allow-raw -- Hold the read lock across writer admission.
    snapshotOpen = true;
    // These stores use rollback journals. SQLite itself distinguishes a healthy
    // writer's journal from a hot journal; readOnly refuses hot-journal playback.
    const mode = reader.prepare("PRAGMA journal_mode").get()?.journal_mode; // sqlite-allow-raw -- Observe, never change, the native journaling mode.
    if (!["delete", "truncate", "persist"].includes(String(mode))) {
      throw new Error("Existing SQLite storage requires rollback journal mode.");
    }
    // Keep the snapshot open, but let ROLLBACK release its lock without waiting
    // for Bun to finalize retained statements after close_v2.
    reader.exec("PRAGMA locking_mode = NORMAL"); // sqlite-allow-raw -- Restore connection-local lock policy.
    if (!existing) {
      options.validate?.(reader);
    }
    if (!options.write) {
      return operation(reader, () => {
        throw new Error("Read-only SQLite observation cannot admit a writer.");
      });
    }
    writer = openNodeSqliteDatabase(resolveExistingSqliteFileUri(pathname));
    setSqliteBusyTimeout(writer, options.busyTimeoutMs);
    const database = writer;
    return operation(database, (write, transactionOptions) => {
      // Waiting while our reader blocks another writer's commit would deadlock.
      // Try once, then release the snapshot on BUSY; no recovery is attempted.
      return runWithSqliteBusyTimeout(database, 0, (restore) =>
        runSqliteImmediateTransactionSync(
          database,
          () => {
            if (snapshotOpen) {
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
