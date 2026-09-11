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
      assertPath(fs.lstatSync(databasePath), "file");
    }
    const db = openNodeSqliteDatabase(databasePath, { readOnly: !write });
    try {
      setSqliteBusyTimeout(db, 5000);
      if (write) {
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
        fs.chmodSync(databasePath, 0o600);
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
