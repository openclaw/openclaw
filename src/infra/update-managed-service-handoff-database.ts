import fs, { type Stats } from "node:fs";
import path from "node:path";
import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import {
  withExistingSqliteRollbackDatabase,
  type ExistingSqliteTransaction,
} from "./sqlite-existing-database.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "./sqlite-transaction.js";

export type LeaseRow = { owner: string; payload_json: string; updated_at: number };
export type LeaseTable = LeaseRow & { install_root: string };
export const leaseQueries = (db: HandoffDatabase) =>
  getNodeSqliteKysely<{ managed_update_handoffs: LeaseTable }>(db);

export type ManagedUpdateLeaseDatabaseIdentity = Readonly<{
  databasePath: string;
  databaseIdentity: string;
  parentIdentity: string;
}>;

function assertPath(stat: Stats, kind: "directory" | "file") {
  if (
    stat.isSymbolicLink() ||
    !(kind === "directory" ? stat.isDirectory() : stat.isFile()) ||
    (kind === "file" && stat.nlink !== 1) ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error("managed handoff lease " + kind + " is unsafe");
  }
}

/**
 * The store chmods the file to 0600 after every write, so excess read bits on a
 * path we own are its own interrupted work: `open` creates the file under the
 * caller's umask, and a crash before that chmod leaves it readable. Restore the
 * invariant instead of refusing, which would otherwise lock the product out of its
 * own state for every install root until an operator deleted the file by hand.
 *
 * Excess bits here are defense in depth rather than a live exposure: assertPath
 * enforces a 0700 owned directory on every read and every write, and a single
 * link, so no other user could traverse to this inode or hold a descriptor on it
 * whatever the file's own mode said. Write bits are still refused rather than
 * repaired, because chmod cannot revoke a descriptor and integrity is the one
 * thing the directory guarantee would not restore. Ownership, type and link count
 * are likewise not ours to repair; all of those still refuse in assertPath.
 */
function repairPrivateFileMode(databasePath: string, stat: Stats): Stats {
  if (
    process.platform === "win32" ||
    (stat.mode & 0o077) === 0 ||
    (stat.mode & 0o022) !== 0 ||
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    return stat;
  }
  fs.chmodSync(databasePath, 0o600);
  return fs.lstatSync(databasePath);
}

/** Capture only an already-admitted database, never provision one during recovery. */
export function captureManagedUpdateLeaseDatabaseIdentity(
  databasePath: string,
): ManagedUpdateLeaseDatabaseIdentity {
  const canonical = fs.realpathSync(databasePath);
  const file = fs.lstatSync(canonical);
  const parent = fs.lstatSync(path.dirname(canonical));
  assertPath(file, "file");
  assertPath(parent, "directory");
  return Object.freeze({
    databasePath: canonical,
    databaseIdentity: `${file.dev}:${file.ino}`,
    parentIdentity: `${parent.dev}:${parent.ino}`,
  });
}

export function assertManagedUpdateLeaseDatabaseIdentity(
  binding: ManagedUpdateLeaseDatabaseIdentity,
): void {
  const actual = captureManagedUpdateLeaseDatabaseIdentity(binding.databasePath);
  if (
    actual.databasePath !== binding.databasePath ||
    actual.databaseIdentity !== binding.databaseIdentity ||
    actual.parentIdentity !== binding.parentIdentity
  ) {
    throw new Error("managed handoff lease database identity changed");
  }
}

/** Existing managed-update lease storage; extraction does not change its schema. */
export function createManagedHandoffLeaseDatabase(
  databasePath: string,
  existingIdentity?: ManagedUpdateLeaseDatabaseIdentity,
) {
  if (existingIdentity && databasePath !== existingIdentity.databasePath) {
    throw new Error("managed handoff lease database path changed");
  }
  const existingTransactions = new WeakMap<HandoffDatabase, ExistingSqliteTransaction>();
  function withDatabase<T>(write: boolean, operation: (db: HandoffDatabase) => T): T {
    if (existingIdentity) {
      return withExistingSqliteRollbackDatabase(
        databasePath,
        {
          write,
          busyTimeoutMs: 5000,
          assertIdentity: () => assertManagedUpdateLeaseDatabaseIdentity(existingIdentity),
          validate: (db) => {
            executeSqliteQuerySync(
              db,
              leaseQueries(db).selectFrom("managed_update_handoffs").selectAll().limit(0),
            );
          },
        },
        (db, transact) => {
          existingTransactions.set(db, transact);
          try {
            return operation(db);
          } finally {
            existingTransactions.delete(db);
          }
        },
      );
    }
    const dir = path.dirname(databasePath);
    if (write) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(dir);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      ) {
        throw new Error("managed handoff lease directory is unsafe");
      }
      fs.chmodSync(dir, 0o700);
    }
    assertPath(fs.lstatSync(dir), "directory");
    if (!write || fs.existsSync(databasePath)) {
      assertPath(repairPrivateFileMode(databasePath, fs.lstatSync(databasePath)), "file");
    }
    const db = openNodeSqliteDatabase(databasePath, { readOnly: !write });
    try {
      setSqliteBusyTimeout(db, 5000);
      if (write) {
        // Narrow the window the repair above exists for: `open` may have just
        // created the file, and creating the table writes to disk before this.
        fs.chmodSync(databasePath, 0o600);
        executeSqliteQuerySync(
          db,
          leaseQueries(db)
            .schema.createTable("managed_update_handoffs")
            .ifNotExists()
            .addColumn("install_root", "text", (column) => column.notNull().primaryKey())
            .addColumn("owner", "text", (column) => column.notNull())
            .addColumn("payload_json", "text", (column) => column.notNull())
            .addColumn("updated_at", "integer", (column) => column.notNull())
            .modifyEnd(sql`STRICT`),
        );
      }
      return operation(db);
    } finally {
      // Canonical rollback may already close a damaged handle; keep its original error.
      if (db.isOpen) {
        db.close();
      }
    }
  }
  return Object.assign(withDatabase, {
    transact<T>(db: HandoffDatabase, operation: () => T, options: SqliteTransactionOptions): T {
      const assertCurrent = () => {
        if (existingIdentity) {
          assertManagedUpdateLeaseDatabaseIdentity(existingIdentity);
        }
      };
      assertCurrent();
      const transact: ExistingSqliteTransaction =
        existingTransactions.get(db) ??
        ((write, transactionOptions) =>
          runSqliteImmediateTransactionSync(db, write, transactionOptions));
      return transact(
        () => {
          assertCurrent();
          return operation();
        },
        {
          ...options,
          withCommit: (commit) => {
            assertCurrent();
            commit();
          },
        },
      );
    },
  });
}
