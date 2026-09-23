import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createSqliteWalReclamationResult } from "../infra/sqlite-wal-reclamation.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  isOpenClawDatabaseMaintenanceResourceOwned,
} from "./openclaw-state-db-async-lifecycle.js";
import {
  createStateDatabaseRetainer,
  type StateDatabaseBorrowers,
} from "./openclaw-state-db-borrow.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    isOpen = true;
    isTransaction = false;
    close() {
      this.isOpen = false;
    }
  },
}));

function fixture(inTransaction = false) {
  // This constructor is a pure JavaScript mock; no native database is opened.
  const database: OpenClawStateDatabase = {
    db: new DatabaseSync(":memory:"),
    path: "/fixture/state.sqlite",
    walMaintenance: {
      close: () => true,
      checkpoint: () => true,
      reclaimFreePages: createSqliteWalReclamationResult,
    },
  };
  const borrowers = new WeakMap<DatabaseSync, StateDatabaseBorrowers>();
  Object.defineProperty(database.db, "isTransaction", { value: inTransaction });
  const retire = vi.fn((source: OpenClawStateDatabase, _retireAdmission: boolean) =>
    source.db.close(),
  );
  const retainer = createStateDatabaseRetainer(
    { borrowers, cachedDatabases: new Map([[database.path, database]]) },
    {
      assertOpen() {},
      capture: () => ({ assertCurrent() {} }),
      retire,
      retainFailed: vi.fn(),
      touch() {},
    },
  );
  const scope = createOpenClawDatabaseMaintenanceScope(() => undefined);
  scope.own(database.db, "shared-handles", () => database.db.close());
  return { database, borrowers, retire, retainer, scope };
}

describe.each(["borrowForRead", "retainForIndependentRead"] as const)("%s", (readPin) => {
  it.each([false, true])("observes a read pin only after source admission=%s", async (admitted) => {
    const { database, retainer, scope } = fixture(readPin === "retainForIndependentRead");
    const pin = retainer[readPin](database.path);
    expect(pin).toBeDefined();
    expect(isOpenClawDatabaseMaintenanceResourceOwned(database.db, scope)).toBe(true);
    if (admitted) {
      pin?.observe();
    }
    pin?.release();
    await scope.close();
    expect(database.db.isOpen).toBe(admitted);
  });

  it.each([false, true])(
    "keeps the original writer retirement current after read admission=%s",
    async (admitted) => {
      const { database, retainer, retire, scope } = fixture(readPin === "retainForIndependentRead");
      const writer = scope.run(() => retainer.retain(database));
      const pin = retainer[readPin](database.path);
      writer.release();
      expect(retire).not.toHaveBeenCalled();
      if (admitted) {
        pin?.observe();
      }
      pin?.release();
      expect(retire.mock.calls).toEqual(admitted ? [] : [[database, false]]);
      expect(database.db.isOpen).toBe(admitted);
      await scope.close();
      expect(database.db.isOpen).toBe(admitted);
    },
  );

  it("does not let a stale scoped writer replace an unconditional cache cleanup request", async () => {
    const { database, borrowers, retainer, retire, scope } = fixture(
      readPin === "retainForIndependentRead",
    );
    const writer = scope.run(() => retainer.retain(database));
    const pin = retainer[readPin](database.path);
    const owner = borrowers.get(database.db);
    if (!owner || !pin) {
      throw new Error("Expected retained native owner");
    }
    const cacheCleanup = vi.fn(() => database.db.close());
    owner.retiring = true;
    owner.retirement = { ordinary: true, isCurrent: () => true, retire: cacheCleanup };
    writer.release();
    pin.observe();
    pin.release();
    expect(cacheCleanup).toHaveBeenCalledOnce();
    expect(retire).not.toHaveBeenCalled();
    expect(database.db.isOpen).toBe(false);
    await scope.close();
  });

  it("rejects stale observation and releases the original pin once", async () => {
    const { database, borrowers, retainer, retire, scope } = fixture(
      readPin === "retainForIndependentRead",
    );
    const pin = retainer[readPin](database.path);
    expect(pin).toBeDefined();
    try {
      expect(() => pin?.assertCurrent()).not.toThrow();
      database.db.close();
      expect(() => pin?.assertCurrent()).toThrow("lost its original native owner");
      expect(() => pin?.observe()).toThrow("lost its original native owner");
      expect(isOpenClawDatabaseMaintenanceResourceOwned(database.db, scope)).toBe(true);
      pin?.release();
      pin?.release();
      expect(borrowers.get(database.db)?.references.size).toBe(0);
      expect(retire).not.toHaveBeenCalled();
    } finally {
      pin?.release();
      await scope.close();
    }
  });
});

it("pins an independent transaction without exposing a native snapshot source", async () => {
  const { database, borrowers, retainer, scope } = fixture(true);
  expect(() => retainer.borrowForRead(database.path)).toThrow("inside a native transaction");
  expect(borrowers.has(database.db)).toBe(false);
  const pin = retainer.retainForIndependentRead(database.path);
  try {
    expect(pin).toBeDefined();
    expect(pin).not.toHaveProperty("database");
    expect(() => pin?.assertCurrent()).not.toThrow();
    expect(database.db.isTransaction).toBe(true);
    expect(database.db.isOpen).toBe(true);
    expect(isOpenClawDatabaseMaintenanceResourceOwned(database.db, scope)).toBe(true);
  } finally {
    pin?.release();
    await scope.close();
  }
  expect(database.db.isOpen).toBe(false);
});
