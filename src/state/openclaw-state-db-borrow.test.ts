import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
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

function fixture() {
  // This constructor is a pure JavaScript mock; no native database is opened.
  const database: OpenClawStateDatabase = {
    db: new DatabaseSync(":memory:"),
    path: "/fixture/state.sqlite",
    walMaintenance: { close: () => true, checkpoint: () => true },
  };
  const borrowers = new WeakMap<DatabaseSync, StateDatabaseBorrowers>();
  const retire = vi.fn((source: OpenClawStateDatabase, _retireAdmission: boolean) =>
    source.db.close(),
  );
  const retainer = createStateDatabaseRetainer(
    { borrowers, cachedDatabases: new Map([[database.path, database]]) },
    { assertOpen() {}, capture: () => ({ assertCurrent() {} }), retire, retainFailed: vi.fn() },
  );
  const scope = createOpenClawDatabaseMaintenanceScope(() => undefined);
  scope.own(database.db, "shared-handles", () => database.db.close());
  return { database, borrowers, retire, retainer, scope };
}

it.each([false, true])("observes a read pin only after source admission=%s", async (admitted) => {
  const { database, retainer, scope } = fixture();
  const pin = retainer.borrowForRead(database.path);
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
    const { database, retainer, retire, scope } = fixture();
    const writer = scope.run(() => retainer.retain(database));
    const pin = retainer.borrowForRead(database.path);
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
  const { database, borrowers, retainer, retire, scope } = fixture();
  const writer = scope.run(() => retainer.retain(database));
  const pin = retainer.borrowForRead(database.path);
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
