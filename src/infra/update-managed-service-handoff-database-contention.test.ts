import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import * as database from "./update-managed-service-handoff-database.js";
import * as lease from "./update-managed-service-handoff-lease.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let databasePath: string;

beforeEach(() => {
  root = dirs.make("handoff-older-writer-");
  databasePath = path.join(root, "managed-update-handoffs.sqlite");
  database.createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
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
const warning = (details: Record<string, unknown>) =>
  ["SQLite transaction lock wait failed", expect.objectContaining(details)] as const;

it.each(["existing identity", "original acquisition"] as const)(
  "reports older-writer contention for %s",
  async (kind) => {
    const options = {
      databasePath,
      serviceManagerEnv: {},
      ...(kind === "existing identity"
        ? { existingIdentity: database.captureManagedUpdateLeaseDatabaseIdentity(databasePath) }
        : { originalUpdateKey: root }),
    };
    const logger = { warn: vi.fn() };
    const store = await lease.prepareManagedHandoffLeaseStore(options, logger);
    // Published writers hold SQLite directly and never participate in the new file mutex.
    using holder = new DatabaseSync(databasePath);
    holder.exec("BEGIN IMMEDIATE");
    const failure = captureError(() => store.acquire(root, "candidate", { kind: "update" }));
    expect(failure.message).toMatch(/managed handoff database is locked/i);
    expect(failure.message).toMatch(/another OpenClaw update or Doctor from an older release/i);
    expect(failure.message).toMatch(/wait for it to finish, then rerun this command/i);
    expect(failure.cause).toMatchObject({ message: "database is locked", errcode: 5 });
    expect([failure, failure.cause].map(isSqliteLockError)).toEqual([true, true]);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      ...warning({
        step: "begin",
        failureKind: "lock-contention",
        beginAdmission: expect.objectContaining({ nativeAttempts: 1 }),
      }),
    );
    expect(store.read(root)).toEqual({ kind: "absent" });

    const legacy = lease.createManagedHandoffLeaseStore(options, { warn: vi.fn() });
    const legacyFailure = captureError(() => legacy.acquire(root, "legacy", { kind: "update" }));
    expect([legacyFailure.message, legacyFailure.cause]).toEqual(["database is locked", undefined]);

    holder.exec("COMMIT");
    expect(store.acquire(root, "candidate", { kind: "update" }).kind).toBe("acquired");
    expect(holder.prepare("SELECT owner FROM managed_update_handoffs").all()).toEqual([
      { owner: "candidate" },
    ]);
  },
);

it.each(["callback", "commit"] as const)("preserves native %s lock errors", async (phase) => {
  const owner = await database.prepareManagedHandoffLeaseDatabase(databasePath);
  const logger = { warn: vi.fn() };
  let original: Error | undefined;
  if (phase === "callback") {
    using holder = new DatabaseSync(databasePath);
    using contender = new DatabaseSync(databasePath);
    holder.exec("BEGIN IMMEDIATE");
    original = captureError(() => contender.exec("BEGIN IMMEDIATE"));
    holder.exec("ROLLBACK");
  }
  using reader =
    phase === "commit" ? new DatabaseSync(databasePath, { readOnly: true }) : undefined;
  if (reader) {
    reader.exec("BEGIN");
    reader.prepare("SELECT owner FROM managed_update_handoffs").all();
  }
  const write = (db: DatabaseSync) => {
    if (original) {
      throw original;
    }
    db.exec("PRAGMA busy_timeout=0");
    const insert = db.prepare("INSERT INTO managed_update_handoffs VALUES (?, ?, '{}', 1, NULL)");
    insert.run(root, "rolled-back");
  };
  const failure = captureError(() =>
    owner(true, (db) => owner.transact(db, () => write(db), { logger })),
  );
  expect([failure.message, failure.cause]).toEqual(["database is locked", undefined]);
  if (phase === "callback") {
    expect(failure).toBe(original);
  } else {
    expect(isSqliteLockError(failure)).toBe(true);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      ...warning({ step: "commit", failureKind: "lock-contention" }),
    );
    reader?.exec("ROLLBACK");
    expect(reader?.prepare("SELECT owner FROM managed_update_handoffs").all()).toEqual([]);
  }
});
