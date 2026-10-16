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
} from "./delivery-queue-sqlite.kernel.js";
import { seedDeliveryQueueEntry } from "./delivery-queue-sqlite.test-support.js";
import { executeDeliveryQueueOperation } from "./delivery-queue-worker-store.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

describe("delivery queue health publication", () => {
  let stateDir: string;
  let tmpDir: string;
  const QUEUE = "test-q";
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
      seedDeliveryQueueEntry({
        queueName: QUEUE,
        entry: { id: "health", enqueuedAt: 1, retryCount: 0 },
        status,
        stateDir,
      });
      const expected = await countFailedDeliveryQueueEntries(stateDir);
      expect(expected).toEqual(
        status === "failed"
          ? [{ queueName: QUEUE, count: 1, oldestFailedAt: expect.any(Number) }]
          : [],
      );
      await writeConfigMachineStateAsync("config.lastTouchedAt", "changed", {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const requests = vi.spyOn(Worker.prototype, "postMessage");
      const observer = observeParentSqlite();
      try {
        expect(await countFailedDeliveryQueueEntries(stateDir)).toEqual(expected);
        expect(await countFailedDeliveryQueueEntries(stateDir)).toEqual(expected);
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
    seedDeliveryQueueEntry({ queueName, entry, stateDir });
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
        seedDeliveryQueueEntry({
          queueName: QUEUE,
          entry: {
            id,
            enqueuedAt,
            retryCount: 0,
            recoveryState: "completed_bounded",
            completionRetention,
          },
          status: "failed",
          stateDir,
        });
      }
      expect(await countFailedDeliveryQueueEntries(stateDir)).toMatchObject([{ count: 2 }]);
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
      expect(await countFailedDeliveryQueueEntries(stateDir)).toMatchObject([{ count: 1 }]);
    },
  );

  it("does not publish rolled-back health or retain health across database replacement", async () => {
    const entry = { id: "health-rollback", enqueuedAt: 1, retryCount: 0 };
    seedDeliveryQueueEntry({ queueName: QUEUE, entry, status: "failed", stateDir });
    const expected = await countFailedDeliveryQueueEntries(stateDir);
    const database = openTestDatabase();
    expect(() =>
      runSqliteImmediateTransactionSync(database.db, () => {
        seedDeliveryQueueEntry({ queueName: QUEUE, entry, status: "pending", stateDir });
        expect(countFailedDeliveryQueueEntriesInDatabase(database)).toEqual([]);
        throw new Error("rollback health");
      }),
    ).toThrow("rollback health");
    expect(await countFailedDeliveryQueueEntries(stateDir)).toEqual(expected);
    await closeOpenClawStateDatabaseAsync();
    fs.rmSync(stateDir, { recursive: true });
    fs.mkdirSync(stateDir);
    expect(await countFailedDeliveryQueueEntries(stateDir)).toEqual([]);
  });
});
