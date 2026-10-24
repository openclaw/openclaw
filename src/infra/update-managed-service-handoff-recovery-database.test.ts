import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as schemaHelpers from "../state/openclaw-state-db-schema-helpers.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
  leaseQueries,
  readManagedHandoffRepairMetadata,
} from "./update-managed-service-handoff-database.js";
import { parseManagedHandoffLeasePayload } from "./update-managed-service-handoff-schema.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const table = "managed_update_handoffs";
const fields = "install_root, owner, payload_json, updated_at";
const oldFields = {
  version: 2 as const,
  executor: { pid: 100, startIdentity: "executor-start" },
  helper: { pid: 101, startIdentity: "helper-start" },
  action: { kind: "update" as const },
};
const oldPayload = JSON.stringify(oldFields);
const oldRow = { owner: "owner", payload_json: oldPayload, updated_at: 123 };
const retainedMetadata = JSON.stringify({ fixture: "opaque to old readers" });
const { owner, updated_at: updatedAt } = oldRow;
const oldLease = { ...oldFields, key: "original", owner, payload: oldPayload, updatedAt };
let databasePath: string;
let database: ReturnType<typeof createManagedHandoffLeaseDatabase>;

beforeEach(() => {
  const directory = fs.realpathSync(dirs.make("handoff-repair-column-"));
  fs.chmodSync(directory, 0o700);
  databasePath = path.join(directory, "managed-update-handoffs.sqlite");
  database = createManagedHandoffLeaseDatabase(databasePath);
});
afterEach(() => vi.restoreAllMocks());

function createOldStore() {
  withRawDatabase((db) => {
    db.exec(
      `CREATE TABLE ${table} (install_root TEXT NOT NULL PRIMARY KEY, owner TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT`,
    );
    insertLease(db);
  });
  fs.chmodSync(databasePath, 0o600);
}

function withRawDatabase(operation: (db: DatabaseSync) => void) {
  using db = new DatabaseSync(databasePath);
  operation(db);
}

const insertLease = (db: DatabaseSync, key = "original", leaseOwner = "owner", time = 123) =>
  db
    .prepare(`INSERT INTO ${table} (${fields}) VALUES (?, ?, ?, ?)`)
    .run(key, leaseOwner, oldPayload, time);
const select = (db: DatabaseSync, columns: string, suffix = "") =>
  db.prepare(`SELECT ${columns} FROM ${table}${suffix}`);
const leaseRow = (db: DatabaseSync) =>
  select(db, "owner, payload_json, updated_at", " WHERE install_root = 'original'").get();
const metadataReader = (db: DatabaseSync) => () =>
  readManagedHandoffRepairMetadata(db, oldLease, (operation) =>
    database.transact(db, operation, {}),
  );
const recoveryColumn = (db: DatabaseSync) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .find((column) => column.name === "recovery_json");

function writeMetadata() {
  database(true, (db) => {
    const read = metadataReader(db);
    expect(read()).toBeNull();
    expect(read()).toBeNull();
    const update = leaseQueries(db)
      .updateTable("managed_update_handoffs")
      .set({ recovery_json: retainedMetadata })
      .where("install_root", "=", oldLease.key);
    database.transact(db, () => executeSqliteQuerySync(db, update), {});
  });
}

it.each(["existing", "new"] as const)("preserves old-reader compatibility in %s stores", (kind) => {
  if (kind === "existing") {
    createOldStore();
    const before = fs.readFileSync(databasePath);
    for (const write of [false, true]) {
      database(write, (db) => {
        expect(recoveryColumn(db)).toBeUndefined();
        expect(leaseRow(db)).toEqual(oldRow);
      });
    }
    expect(fs.readFileSync(databasePath)).toEqual(before);
  } else {
    database(true, (db) => insertLease(db));
  }
  writeMetadata();
  withRawDatabase((db) => {
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    const row = leaseRow(db);
    expect(row).toEqual(oldRow);
    expect(parseManagedHandoffLeasePayload(String(row?.payload_json))).toEqual(oldFields);
    db.prepare(
      `UPDATE ${table} SET payload_json = ?, updated_at = ? WHERE install_root = ? AND owner = ?`,
    ).run(oldPayload, 456, "original", "owner");
    insertLease(db, "old-writer", "another-owner", 789);
    expect(recoveryColumn(db)).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
  });
  database(false, (db) =>
    expect(select(db, "install_root, recovery_json", " ORDER BY install_root").all()).toEqual([
      { install_root: "old-writer", recovery_json: null },
      { install_root: "original", recovery_json: retainedMetadata },
    ]),
  );
});

it("does not retain a rolled-back column admission and lets existing readers see its later publication", () => {
  createOldStore();
  database(true, (db) => {
    const ensure = schemaHelpers.ensureColumn;
    vi.spyOn(schemaHelpers, "ensureColumn").mockImplementationOnce(
      (dbHandle, tableName, column) => {
        ensure(dbHandle, tableName, column);
        throw new Error("interrupted metadata admission");
      },
    );
    const read = metadataReader(db);
    expect(read).toThrow("interrupted metadata admission");
    expect(recoveryColumn(db)).toBeUndefined();
    expect(read()).toBeNull();
    expect(recoveryColumn(db)).toBeDefined();
  });
  const reader = createManagedHandoffLeaseDatabase(
    databasePath,
    captureManagedUpdateLeaseDatabaseIdentity(databasePath),
  );
  const retained = reader.retainReadConnection();
  try {
    for (const metadata of [null, retainedMetadata]) {
      if (metadata) {
        writeMetadata();
      }
      reader(false, (db) =>
        expect(select(db, "recovery_json").get()).toEqual({ recovery_json: metadata }),
      );
    }
  } finally {
    retained[Symbol.dispose]();
  }
});

it.each(["", "{"])("does not interpret malformed metadata %j as a legacy record", (metadata) => {
  createOldStore();
  database(true, (db) => {
    const read = metadataReader(db);
    expect(read()).toBeNull();
    db.prepare(`UPDATE ${table} SET recovery_json = ? WHERE install_root = ?`).run(
      metadata,
      "original",
    );
    expect(read).toThrow("metadata is unreadable");
    expect(select(db, "payload_json").get()).toEqual({ payload_json: oldPayload });
  });
});
