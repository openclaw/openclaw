import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as sqliteObserver from "../../test/helpers/sqlite-parent-observer.js";
import { writeConfigMachineStateAsync } from "../state/config-machine-state-async.js";
import * as stateDatabase from "../state/openclaw-state-db.js";
import { pruneDeliveryQueueTombstones } from "./delivery-queue-sqlite-bound.js";
import * as queue from "./delivery-queue-sqlite.js";
import * as kernel from "./delivery-queue-sqlite.kernel.js";
import * as fixtures from "./delivery-queue-sqlite.test-support.js";
import { executeDeliveryQueueOperation } from "./delivery-queue-worker-store.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

let stateDir: string;
let tmpDir: string;
let observer: ReturnType<typeof sqliteObserver.observeParentSqlite> | undefined;
const QUEUE = "test-q";
type Seed = Parameters<typeof fixtures.seedDeliveryQueueEntry>[0];
const boundedRetention = { idPrefix: "expiry-", maxAgeMs: 60_000, maxEntries: 10 };
const seed = <const T extends Pick<Seed["entry"], "id"> & Partial<Seed["entry"]>>(
  entry: T,
  status: Seed["status"] = "pending",
  queueName = QUEUE,
) => {
  // Terminalization compares serialized entries, including property order.
  const value = { id: entry.id, enqueuedAt: 1, retryCount: 0, ...entry };
  fixtures.seedDeliveryQueueEntry({ queueName, entry: value, status, stateDir });
  return value;
};
const seedBounded = (
  id: string,
  enqueuedAt: number,
  completionRetention: Seed["entry"]["completionRetention"],
  status: Seed["status"],
) => seed({ id, enqueuedAt, recoveryState: "completed_bounded", completionRetention }, status);
const load = (id: string) => fixtures.loadDeliveryQueueEntry(QUEUE, id, stateDir, "all");
const count = () => queue.countFailedDeliveryQueueEntries(stateDir);
const stateOptions = () => ({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } });
const touchConfig = () =>
  writeConfigMachineStateAsync("config.lastTouchedAt", "changed", stateOptions());
const openTestDatabase = () => stateDatabase.openOpenClawStateDatabase(stateOptions());

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-dq-health-"));
  stateDir = path.join(tmpDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(async () => {
  observer?.restore();
  observer = undefined;
  await stateDatabase.closeOpenClawStateDatabaseAsync();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

it.each(["pending", "failed"] as const)("reuses idle %s health", async (status) => {
  seed({ id: "health" }, status);
  const expected = await count();
  expect(expected).toEqual(
    status === "failed" ? [{ queueName: QUEUE, count: 1, oldestFailedAt: expect.any(Number) }] : [],
  );
  await touchConfig();
  using requests = vi.spyOn(Worker.prototype, "postMessage");
  observer = sqliteObserver.observeParentSqlite();
  expect([await count(), await count()]).toEqual([expected, expected]);
  expect(requests).not.toHaveBeenCalled();
  expect(observer.counts).toEqual(sqliteObserver.emptySqliteCounts());
});

it("refreshes health after worker failure and in-process completion", async () => {
  const queueName = "outbound-preparing-v1";
  const entry = seed(
    {
      id: "health-worker",
      retainOnFailure: true,
      preparationState: "claimed",
      preparationOwnerId: "health-owner",
      preparationLeaseExpiresAt: Date.now() + 60_000,
    },
    "pending",
    queueName,
  );
  const context = queue.captureDeliveryQueueStateContext(stateDir);
  expect(await queue.countFailedDeliveryQueueEntries(stateDir, context)).toEqual([]);
  await executeDeliveryQueueOperation(context, undefined, {
    type: "deliveryQueue.failPreparation",
    input: { entry },
  });
  expect(await queue.countFailedDeliveryQueueEntries(stateDir, context)).toEqual([
    { queueName, count: 1, oldestFailedAt: expect.any(Number) },
  ]);
  kernel.completeDeliveryQueueEntryInDatabase(openTestDatabase(), queueName, entry.id);
  expect(await queue.countFailedDeliveryQueueEntries(stateDir, context)).toEqual([]);
});

it.each(["age", "count"] as const)("%s retention refreshes health", async (policy) => {
  const now = Date.now();
  const completionRetention = { idPrefix: "health-", maxAgeMs: 3_600_000, maxEntries: 1 };
  for (const [id, enqueuedAt] of [
    ["health-old", now - 7_200_000],
    ["health-new", now],
  ] as const) {
    seedBounded(id, enqueuedAt, completionRetention, "failed");
  }
  expect(await count()).toMatchObject([{ count: 2 }]);
  if (policy === "age") {
    await queue.pruneExpiredDeliveryQueueTombstones(stateDir);
  } else {
    const { db } = openTestDatabase();
    runSqliteImmediateTransactionSync(db, () =>
      pruneDeliveryQueueTombstones(db, now - 7_200_000, {
        queueName: QUEUE,
        idPrefix: "health-",
      }),
    );
  }
  expect(await count()).toMatchObject([{ count: 1 }]);
});

it("does not publish rolled-back health or retain health across database replacement", async () => {
  const entry = seed({ id: "health-rollback" }, "failed");
  const expected = await count();
  const database = openTestDatabase();
  expect(() =>
    runSqliteImmediateTransactionSync(database.db, () => {
      seed(entry);
      expect(kernel.countFailedDeliveryQueueEntriesInDatabase(database)).toEqual([]);
      throw new Error("rollback health");
    }),
  ).toThrow("rollback health");
  expect(await count()).toEqual(expected);
  await stateDatabase.closeOpenClawStateDatabaseAsync();
  fs.rmSync(stateDir, { recursive: true });
  fs.mkdirSync(stateDir);
  expect(await count()).toEqual([]);
});

it("skips empty tombstone sweeps until a producer commits a terminal row", async () => {
  await queue.pruneExpiredDeliveryQueueTombstones(stateDir);
  await touchConfig();
  using requests = vi.spyOn(Worker.prototype, "postMessage");
  await queue.pruneExpiredDeliveryQueueTombstones(stateDir);
  await queue.pruneExpiredDeliveryQueueTombstones(stateDir);
  expect(requests).not.toHaveBeenCalled();

  seed({ id: "expired-ordinary", enqueuedAt: Date.now() - 31 * 86_400_000 }, "completed");
  await queue.pruneExpiredDeliveryQueueTombstones(stateDir);
  expect(load("expired-ordinary")).toBeNull();

  await queue.pruneExpiredDeliveryQueueTombstones(stateDir);
  requests.mockClear();
  await queue.pruneExpiredDeliveryQueueTombstones(stateDir);
  expect(requests).not.toHaveBeenCalled();
});

it("expires a newly terminalized bounded receipt only after its exact deadline", () => {
  const database = openTestDatabase();
  using now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  kernel.pruneExpiredDeliveryQueueTombstonesInDatabase(database);
  const entry = seed({
    id: "expiry-bounded",
    enqueuedAt: Date.now(),
    completionRetention: boundedRetention,
  });
  const params = { queueName: QUEUE, id: entry.id, entry };
  const prepared = kernel.prepareDeliveryQueueTerminalEntry(params);
  const result = kernel.terminalizePendingDeliveryQueueEntryInDatabase(database, prepared);
  expect(result).toEqual({ status: "terminalized", retained: true });
  kernel.pruneExpiredDeliveryQueueTombstonesInDatabase(database);
  observer = sqliteObserver.observeParentSqlite();
  now.mockReturnValue(1_060_000);
  kernel.pruneExpiredDeliveryQueueTombstonesInDatabase(database);
  expect(observer.counts).toEqual(sqliteObserver.emptySqliteCounts());
  observer.restore();
  observer = undefined;
  expect(load(entry.id)).not.toBeNull();
  now.mockReturnValue(1_060_001);
  kernel.pruneExpiredDeliveryQueueTombstonesInDatabase(database);
  expect(load(entry.id)).toBeNull();
});

it("does not retain a rolled-back empty expiry over a committed tombstone", () => {
  const database = openTestDatabase();
  const id = "expiry-rollback";
  seed({ id, enqueuedAt: Date.now() - 31 * 86_400_000 }, "completed");
  expect(() =>
    runSqliteImmediateTransactionSync(database.db, () => {
      kernel.pruneExpiredDeliveryQueueTombstonesInDatabase(database);
      kernel.pruneExpiredDeliveryQueueTombstonesInDatabase(database);
      throw new Error("rollback expiry");
    }),
  ).toThrow("rollback expiry");
  kernel.pruneExpiredDeliveryQueueTombstonesInDatabase(database);
  expect(load(id)).toBeNull();
});

it("keeps very long bounded retention exact without summing timestamps in JavaScript", () => {
  const database = openTestDatabase();
  const completionRetention = { ...boundedRetention, maxAgeMs: Number.MAX_SAFE_INTEGER };
  for (const [id, enqueuedAt] of [
    ["future", Date.now()],
    ["past", 1],
  ] as const) {
    seedBounded(`expiry-huge-${id}`, enqueuedAt, completionRetention, "completed");
  }
  kernel.pruneExpiredDeliveryQueueTombstonesInDatabase(database);
  expect(load("expiry-huge-future")).not.toBeNull();
  expect(load("expiry-huge-past")).not.toBeNull();
});
