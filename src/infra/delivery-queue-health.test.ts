import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../test/helpers/sqlite-parent-observer.js";
import { writeConfigMachineStateAsync } from "../state/config-machine-state-async.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { pruneDeliveryQueueTombstones } from "./delivery-queue-sqlite-bound.js";
import {
  captureDeliveryQueueStateContext,
  countFailedDeliveryQueueEntries,
  pruneExpiredDeliveryQueueTombstones,
} from "./delivery-queue-sqlite.js";
import {
  completeDeliveryQueueEntryInDatabase,
  countFailedDeliveryQueueEntriesInDatabase,
  prepareDeliveryQueueTerminalEntry,
  pruneExpiredDeliveryQueueTombstonesInDatabase,
  terminalizePendingDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite.kernel.js";
import {
  loadDeliveryQueueEntry,
  seedDeliveryQueueEntry,
} from "./delivery-queue-sqlite.test-support.js";
import { executeDeliveryQueueOperation } from "./delivery-queue-worker-store.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

describe("delivery queue health publication", () => {
  let stateDir: string;
  let tmpDir: string;
  const QUEUE = "test-q";
  type Seed = Parameters<typeof seedDeliveryQueueEntry>[0];
  const seed = (
    entry: Pick<Seed["entry"], "id"> & Partial<Seed["entry"]>,
    status: Seed["status"] = "pending",
    queueName = QUEUE,
  ) =>
    seedDeliveryQueueEntry({
      queueName,
      // Terminalization compares serialized entries, including property order.
      entry: { id: entry.id, enqueuedAt: 1, retryCount: 0, ...entry },
      status,
      stateDir,
    });
  const load = (id: string) => loadDeliveryQueueEntry(QUEUE, id, stateDir, "all");
  const count = () => countFailedDeliveryQueueEntries(stateDir);
  const touchConfig = () =>
    writeConfigMachineStateAsync("config.lastTouchedAt", "changed", {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
  const openTestDatabase = () =>
    openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-dq-health-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(["pending", "failed"] as const)(
    "reuses %s queue health across idle reads and unrelated writer receipts",
    async (status) => {
      seed({ id: "health" }, status);
      const expected = await count();
      expect(expected).toEqual(
        status === "failed"
          ? [{ queueName: QUEUE, count: 1, oldestFailedAt: expect.any(Number) }]
          : [],
      );
      await touchConfig();
      const requests = vi.spyOn(Worker.prototype, "postMessage");
      const observer = observeParentSqlite();
      try {
        expect(await count()).toEqual(expected);
        expect(await count()).toEqual(expected);
        expect(requests).not.toHaveBeenCalled();
        expect(observer.counts).toEqual(emptySqliteCounts());
      } finally {
        requests.mockRestore();
        observer.restore();
      }
    },
  );

  it("refreshes health after worker failure and in-process completion", async () => {
    const queueName = "outbound-preparing-v1";
    const entry = {
      id: "health-worker",
      enqueuedAt: 1,
      retryCount: 0,
      retainOnFailure: true as const,
      preparationState: "claimed" as const,
      preparationOwnerId: "health-owner",
      preparationLeaseExpiresAt: Date.now() + 60_000,
    };
    seed(entry, "pending", queueName);
    const context = captureDeliveryQueueStateContext(stateDir);
    expect(await countFailedDeliveryQueueEntries(stateDir, context)).toEqual([]);
    await executeDeliveryQueueOperation(context, undefined, {
      type: "deliveryQueue.failPreparation",
      input: { entry },
    });
    expect(await countFailedDeliveryQueueEntries(stateDir, context)).toEqual([
      { queueName, count: 1, oldestFailedAt: expect.any(Number) },
    ]);
    completeDeliveryQueueEntryInDatabase(openTestDatabase(), queueName, entry.id);
    expect(await countFailedDeliveryQueueEntries(stateDir, context)).toEqual([]);
  });

  it.each(["age", "count"] as const)(
    "refreshes failed health after %s retention",
    async (policy) => {
      const now = Date.now();
      const completionRetention = { idPrefix: "health-", maxAgeMs: 3_600_000, maxEntries: 1 };
      for (const [id, enqueuedAt] of [
        ["health-old", now - 7_200_000],
        ["health-new", now],
      ] as const) {
        seed({ id, enqueuedAt, recoveryState: "completed_bounded", completionRetention }, "failed");
      }
      expect(await count()).toMatchObject([{ count: 2 }]);
      if (policy === "age") {
        await pruneExpiredDeliveryQueueTombstones(stateDir);
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
    },
  );

  it("does not publish rolled-back health or retain health across database replacement", async () => {
    const entry = { id: "health-rollback", enqueuedAt: 1, retryCount: 0 };
    seed(entry, "failed");
    const expected = await count();
    const database = openTestDatabase();
    expect(() =>
      runSqliteImmediateTransactionSync(database.db, () => {
        seed(entry);
        expect(countFailedDeliveryQueueEntriesInDatabase(database)).toEqual([]);
        throw new Error("rollback health");
      }),
    ).toThrow("rollback health");
    expect(await count()).toEqual(expected);
    await closeOpenClawStateDatabaseAsync();
    fs.rmSync(stateDir, { recursive: true });
    fs.mkdirSync(stateDir);
    expect(await count()).toEqual([]);
  });

  it("skips empty tombstone sweeps until a producer commits a terminal row", async () => {
    await pruneExpiredDeliveryQueueTombstones(stateDir);
    await touchConfig();
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    try {
      await pruneExpiredDeliveryQueueTombstones(stateDir);
      await pruneExpiredDeliveryQueueTombstones(stateDir);
      expect(requests).not.toHaveBeenCalled();

      seed({ id: "expired-ordinary", enqueuedAt: Date.now() - 31 * 86_400_000 }, "completed");
      await pruneExpiredDeliveryQueueTombstones(stateDir);
      expect(load("expired-ordinary")).toBeNull();

      await pruneExpiredDeliveryQueueTombstones(stateDir);
      requests.mockClear();
      await pruneExpiredDeliveryQueueTombstones(stateDir);
      expect(requests).not.toHaveBeenCalled();
    } finally {
      requests.mockRestore();
    }
  });

  it("expires a newly terminalized bounded receipt only after its exact deadline", () => {
    const database = openTestDatabase();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const completionRetention = { idPrefix: "expiry-", maxAgeMs: 60_000, maxEntries: 10 };
    const entry = {
      id: "expiry-bounded",
      enqueuedAt: Date.now(),
      retryCount: 0,
      completionRetention,
    };
    try {
      pruneExpiredDeliveryQueueTombstonesInDatabase(database);
      seed(entry);
      expect(
        terminalizePendingDeliveryQueueEntryInDatabase(
          database,
          prepareDeliveryQueueTerminalEntry({ queueName: QUEUE, id: entry.id, entry }),
        ),
      ).toEqual({ status: "terminalized", retained: true });
      pruneExpiredDeliveryQueueTombstonesInDatabase(database);
      const observer = observeParentSqlite();
      try {
        now.mockReturnValue(1_060_000);
        pruneExpiredDeliveryQueueTombstonesInDatabase(database);
        expect(observer.counts).toEqual(emptySqliteCounts());
      } finally {
        observer.restore();
      }
      expect(load(entry.id)).not.toBeNull();
      now.mockReturnValue(1_060_001);
      pruneExpiredDeliveryQueueTombstonesInDatabase(database);
      expect(load(entry.id)).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it("does not retain a rolled-back empty expiry over a committed tombstone", () => {
    const database = openTestDatabase();
    const entry = {
      id: "expiry-rollback",
      enqueuedAt: Date.now() - 31 * 86_400_000,
      retryCount: 0,
    };
    seed(entry, "completed");
    expect(() =>
      runSqliteImmediateTransactionSync(database.db, () => {
        pruneExpiredDeliveryQueueTombstonesInDatabase(database);
        pruneExpiredDeliveryQueueTombstonesInDatabase(database);
        throw new Error("rollback expiry");
      }),
    ).toThrow("rollback expiry");

    pruneExpiredDeliveryQueueTombstonesInDatabase(database);

    expect(load(entry.id)).toBeNull();
  });

  it("keeps very long bounded retention exact without summing timestamps in JavaScript", () => {
    const database = openTestDatabase();
    const completionRetention = {
      idPrefix: "expiry-",
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      maxEntries: 10,
    };
    for (const [id, enqueuedAt] of [
      ["future", Date.now()],
      ["past", 1],
    ] as const) {
      seed(
        {
          id: `expiry-huge-${id}`,
          enqueuedAt,
          recoveryState: "completed_bounded",
          completionRetention,
        },
        "completed",
      );
    }
    pruneExpiredDeliveryQueueTombstonesInDatabase(database);
    expect(load("expiry-huge-future")).not.toBeNull();
    expect(load("expiry-huge-past")).not.toBeNull();
  });
});
