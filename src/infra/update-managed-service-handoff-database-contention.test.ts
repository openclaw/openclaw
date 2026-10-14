import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
  prepareManagedHandoffLeaseDatabase,
} from "./update-managed-service-handoff-database.js";
import {
  createManagedHandoffLeaseStore,
  prepareManagedHandoffLeaseStore,
} from "./update-managed-service-handoff-lease.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let databasePath: string;

beforeEach(() => {
  root = fs.realpathSync(dirs.make("handoff-older-writer-"));
  databasePath = path.join(root, "managed-update-handoffs.sqlite");
  createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
});

function captureError(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return error;
  }
  throw new Error("Expected the SQLite operation to fail");
}

it.each(["existing identity", "original acquisition"] as const)(
  "explains older-writer contention for prepared %s without retrying SQL",
  async (kind) => {
    const options = {
      databasePath,
      serviceManagerEnv: {},
      ...(kind === "existing identity"
        ? { existingIdentity: captureManagedUpdateLeaseDatabaseIdentity(databasePath) }
        : { originalUpdateKey: root }),
    };
    const logger = { warn: vi.fn() };
    const store = await prepareManagedHandoffLeaseStore(options, logger);
    // Published writers hold SQLite directly and never participate in the new file mutex.
    const holder = new DatabaseSync(databasePath);
    try {
      holder.exec("BEGIN IMMEDIATE");
      const failure = captureError(() => store.acquire(root, "candidate", { kind: "update" }));
      expect(failure.message).toMatch(/managed handoff database is locked/i);
      expect(failure.message).toMatch(/another OpenClaw update or Doctor from an older release/i);
      expect(failure.message).toMatch(/wait for it to finish, then rerun this command/i);
      expect(failure.cause).toMatchObject({ message: "database is locked", errcode: 5 });
      expect(isSqliteLockError(failure)).toBe(true);
      expect(isSqliteLockError(failure.cause)).toBe(true);
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        "SQLite transaction lock wait failed",
        expect.objectContaining({
          step: "begin",
          failureKind: "lock-contention",
          beginAdmission: expect.objectContaining({ nativeAttempts: 1 }),
        }),
      );
      expect(store.read(root)).toEqual({ kind: "absent" });

      const legacy = createManagedHandoffLeaseStore(options, { warn: vi.fn() });
      const legacyFailure = captureError(() => legacy.acquire(root, "legacy", { kind: "update" }));
      expect(legacyFailure.message).toBe("database is locked");
      expect(legacyFailure.cause).toBeUndefined();

      holder.exec("COMMIT");
      expect(store.acquire(root, "candidate", { kind: "update" }).kind).toBe("acquired");
      expect(holder.prepare("SELECT owner FROM managed_update_handoffs").all()).toEqual([
        { owner: "candidate" },
      ]);
    } finally {
      holder.close();
    }
  },
);

it("preserves a lock failure thrown by an admitted callback", async () => {
  const withDatabase = await prepareManagedHandoffLeaseDatabase(databasePath);
  const holder = new DatabaseSync(databasePath);
  const contender = new DatabaseSync(databasePath);
  let failure: Error;
  try {
    holder.exec("BEGIN IMMEDIATE");
    failure = captureError(() => contender.exec("BEGIN IMMEDIATE"));
    holder.exec("ROLLBACK");
  } finally {
    contender.close();
    holder.close();
  }
  expect(
    captureError(() =>
      withDatabase(true, (db) =>
        withDatabase.transact(
          db,
          () => {
            throw failure;
          },
          {},
        ),
      ),
    ),
  ).toBe(failure);
  expect(failure.cause).toBeUndefined();
  expect(failure.message).toBe("database is locked");
});

it("preserves a native commit lock failure and rolls back its admitted write", async () => {
  const withDatabase = await prepareManagedHandoffLeaseDatabase(databasePath);
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  const logger = { warn: vi.fn() };
  try {
    reader.exec("BEGIN");
    reader.prepare("SELECT owner FROM managed_update_handoffs").all();
    const failure = captureError(() =>
      withDatabase(true, (db) =>
        withDatabase.transact(
          db,
          () => {
            db.exec("PRAGMA busy_timeout=0");
            db.prepare("INSERT INTO managed_update_handoffs VALUES (?, ?, '{}', 1, NULL)").run(
              root,
              "rolled-back",
            );
          },
          { logger },
        ),
      ),
    );
    expect(failure.message).toBe("database is locked");
    expect(failure.cause).toBeUndefined();
    expect(isSqliteLockError(failure)).toBe(true);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      "SQLite transaction lock wait failed",
      expect.objectContaining({ step: "commit", failureKind: "lock-contention" }),
    );
    reader.exec("ROLLBACK");
    expect(reader.prepare("SELECT owner FROM managed_update_handoffs").all()).toEqual([]);
  } finally {
    reader.close();
  }
});
