import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const oldFields = {
  version: 2 as const,
  executor: { pid: 100, startIdentity: "executor-start" },
  helper: { pid: 101, startIdentity: "helper-start" },
  action: { kind: "update" as const },
};
const oldPayload = JSON.stringify(oldFields);
const retainedMetadata = JSON.stringify({ fixture: "opaque to old readers" });
const oldLease = {
  ...oldFields,
  key: "original",
  owner: "owner",
  payload: oldPayload,
  updatedAt: 123,
};
let databasePath: string;

beforeEach(() => {
  const directory = fs.realpathSync(dirs.make("handoff-repair-column-"));
  fs.chmodSync(directory, 0o700);
  databasePath = path.join(directory, "managed-update-handoffs.sqlite");
});
afterEach(() => vi.restoreAllMocks());

function createOldStore() {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(
      "CREATE TABLE managed_update_handoffs (install_root TEXT NOT NULL PRIMARY KEY, owner TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT",
    );
    db.prepare(
      "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
    ).run("original", "owner", oldPayload, 123);
  } finally {
    db.close();
  }
  fs.chmodSync(databasePath, 0o600);
}

function recoveryColumn(db: DatabaseSync) {
  return db
    .prepare("PRAGMA table_info(managed_update_handoffs)")
    .all()
    .find((column) => column.name === "recovery_json");
}

function writeMetadata(withDatabase: ReturnType<typeof createManagedHandoffLeaseDatabase>) {
  withDatabase(true, (db) => {
    const read = () =>
      readManagedHandoffRepairMetadata(db, oldLease, (operation) =>
        withDatabase.transact(db, operation, {}),
      );
    expect(read()).toBeNull();
    expect(read()).toBeNull();
    withDatabase.transact(
      db,
      () => {
        executeSqliteQuerySync(
          db,
          leaseQueries(db)
            .updateTable("managed_update_handoffs")
            .set({ recovery_json: retainedMetadata })
            .where("install_root", "=", oldLease.key),
        );
      },
      {},
    );
  });
}

describe("managed handoff database repair metadata compatibility", () => {
  it("leaves legacy stores unchanged during ordinary read and write admission", () => {
    createOldStore();
    const before = fs.readFileSync(databasePath);
    const withDatabase = createManagedHandoffLeaseDatabase(databasePath);
    for (const write of [false, true]) {
      withDatabase(write, (db) => {
        expect(recoveryColumn(db)).toBeUndefined();
        expect(
          db.prepare("SELECT owner, payload_json, updated_at FROM managed_update_handoffs").get(),
        ).toEqual({ owner: "owner", payload_json: oldPayload, updated_at: 123 });
      });
    }
    expect(fs.readFileSync(databasePath)).toEqual(before);
  });

  it.each(["existing", "new"] as const)(
    "preserves old-reader payload bytes and named-column writes on a %s store",
    (kind) => {
      if (kind === "existing") {
        createOldStore();
      }
      const withDatabase = createManagedHandoffLeaseDatabase(databasePath);
      if (kind === "new") {
        withDatabase(true, (db) =>
          db
            .prepare(
              "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
            )
            .run("original", "owner", oldPayload, 123),
        );
      }
      writeMetadata(withDatabase);
      const oldReaderWriter = new DatabaseSync(databasePath);
      try {
        expect(oldReaderWriter.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
        const row = oldReaderWriter
          .prepare(
            "SELECT owner, payload_json, updated_at FROM managed_update_handoffs WHERE install_root = ?",
          )
          .get("original");
        expect(row).toEqual({ owner: "owner", payload_json: oldPayload, updated_at: 123 });
        expect(parseManagedHandoffLeasePayload(String(row?.payload_json))).toEqual(
          JSON.parse(oldPayload),
        );
        oldReaderWriter
          .prepare(
            "UPDATE managed_update_handoffs SET payload_json = ?, updated_at = ? WHERE install_root = ? AND owner = ?",
          )
          .run(oldPayload, 456, "original", "owner");
        oldReaderWriter
          .prepare(
            "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
          )
          .run("old-writer", "another-owner", oldPayload, 789);
        expect(recoveryColumn(oldReaderWriter)).toMatchObject({
          type: "TEXT",
          notnull: 0,
          dflt_value: null,
          pk: 0,
        });
      } finally {
        oldReaderWriter.close();
      }
      withDatabase(false, (db) =>
        expect(
          db
            .prepare(
              "SELECT install_root, recovery_json FROM managed_update_handoffs ORDER BY install_root",
            )
            .all(),
        ).toEqual([
          { install_root: "old-writer", recovery_json: null },
          { install_root: "original", recovery_json: retainedMetadata },
        ]),
      );
    },
  );

  it("does not retain a rolled-back column admission and lets existing readers see its later publication", () => {
    createOldStore();
    const withDatabase = createManagedHandoffLeaseDatabase(databasePath);
    withDatabase(true, (db) => {
      const ensure = schemaHelpers.ensureColumn;
      vi.spyOn(schemaHelpers, "ensureColumn").mockImplementationOnce((database, table, column) => {
        ensure(database, table, column);
        throw new Error("interrupted metadata admission");
      });
      const read = () =>
        readManagedHandoffRepairMetadata(db, oldLease, (operation) =>
          withDatabase.transact(db, operation, {}),
        );
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
      reader(false, (db) =>
        expect(db.prepare("SELECT recovery_json FROM managed_update_handoffs").get()).toEqual({
          recovery_json: null,
        }),
      );
      writeMetadata(withDatabase);
      reader(false, (db) =>
        expect(db.prepare("SELECT recovery_json FROM managed_update_handoffs").get()).toEqual({
          recovery_json: retainedMetadata,
        }),
      );
    } finally {
      retained[Symbol.dispose]();
    }
  });

  it.each(["", "{"])("does not interpret malformed metadata %j as a legacy record", (metadata) => {
    createOldStore();
    const database = createManagedHandoffLeaseDatabase(databasePath);
    database(true, (db) => {
      const read = () =>
        readManagedHandoffRepairMetadata(db, oldLease, (operation) =>
          database.transact(db, operation, {}),
        );
      expect(read()).toBeNull();
      db.prepare("UPDATE managed_update_handoffs SET recovery_json = ? WHERE install_root = ?").run(
        metadata,
        "original",
      );
      expect(read).toThrow("metadata is unreadable");
      expect(db.prepare("SELECT payload_json FROM managed_update_handoffs").get()).toEqual({
        payload_json: oldPayload,
      });
    });
  });
});
