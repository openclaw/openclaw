import fs, { type Stats } from "node:fs";
import path from "node:path";
import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";

export type LeaseRow = { owner: string; payload_json: string; updated_at: number };
export type LeaseTable = LeaseRow & { install_root: string };
export const leaseQueries = (db: HandoffDatabase) =>
  getNodeSqliteKysely<{ managed_update_handoffs: LeaseTable }>(db);

/** Existing managed-update lease storage; extraction does not change its schema. */
export function createManagedHandoffLeaseDatabase(databasePath: string) {
  function assertPath(stat: Stats, kind: "directory" | "file") {
    if (
      stat.isSymbolicLink() ||
      !(kind === "directory" ? stat.isDirectory() : stat.isFile()) ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error("managed handoff lease " + kind + " is unsafe");
    }
  }
  function withDatabase<T>(write: boolean, operation: (db: HandoffDatabase) => T): T {
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
  return withDatabase;
}
