import { describe, expect, it } from "vitest";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntry,
  terminalizePendingDeliveryQueueEntry,
} from "./delivery-queue-sqlite.js";
import { updateDeliveryQueueEntryInDatabase } from "./delivery-queue-sqlite.kernel.js";
import { seedDeliveryQueueEntry } from "./delivery-queue-sqlite.test-support.js";
import type { DeliveryQueueEntryState } from "./delivery-queue-sqlite.types.js";
import { installDeliveryQueueTmpDirHooks } from "./outbound/delivery-queue.test-helpers.js";
import {
  enqueueClaimedSessionDelivery,
  moveSessionDeliveryToFailed,
  releaseSessionDeliveryClaim,
} from "./session-delivery-queue-storage.js";
import { withSessionDeliveryQueue } from "./session-delivery-queue.test-helpers.js";

describe("delivery queue SQLite update atomicity", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const queueName = "test-update-atomicity";

  const enqueueRetained = (stateDir: string, id: string) =>
    seedDeliveryQueueEntry({
      queueName,
      entry: { id, enqueuedAt: Date.now(), retryCount: 0, retainOnFailure: true },
      stateDir,
    });

  const runUpdate = (
    stateDir: string,
    id: string,
    update: (entry: DeliveryQueueEntryState) => DeliveryQueueEntryState,
  ) =>
    runOpenClawStateWriteTransaction(
      (database) => updateDeliveryQueueEntryInDatabase(database, queueName, id, update),
      { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
    );

  it("preserves an independently committed terminal outcome", () => {
    const stateDir = tmpDir();
    const id = "committed-terminalize";
    enqueueRetained(stateDir, id);

    const pending = loadDeliveryQueueEntry(queueName, id, stateDir);
    if (!pending) {
      throw new Error("test invariant: seeded delivery must be pending");
    }
    expect(
      terminalizePendingDeliveryQueueEntry({ queueName, id, entry: pending, stateDir }),
    ).toEqual({ status: "terminalized", retained: true });
    expect(getDeliveryQueueEntryStatus(queueName, id, stateDir)).toBe("failed");

    expect(() =>
      runUpdate(stateDir, id, (entry) => ({ ...entry, retryCount: 999, lastError: "stale" })),
    ).toThrow(new RegExp(`No pending test-update-atomicity delivery queue entry ${id}`));

    expect(getDeliveryQueueEntryStatus(queueName, id, stateDir)).toBe("failed");
    expect(loadDeliveryQueueEntry(queueName, id, stateDir)).toBeNull();
  });

  it("fails closed when a concurrent terminalize lands inside the update window", () => {
    const stateDir = tmpDir();
    const id = "race-terminalize";
    enqueueRetained(stateDir, id);

    expect(() =>
      runUpdate(stateDir, id, (entry) => {
        terminalizePendingDeliveryQueueEntry({
          queueName,
          id,
          entry,
          stateDir,
        });
        return { ...entry, retryCount: 999, lastError: "stale" };
      }),
    ).toThrow(new RegExp(`No pending test-update-atomicity delivery queue entry ${id}`));

    const loaded = loadDeliveryQueueEntry(queueName, id, stateDir);
    expect(loaded?.retryCount).toBe(0);
    expect(loaded?.lastError).toBeUndefined();
  });

  it("keeps a committed session delivery terminal across a real caller update", async () => {
    const payload = {
      kind: "agentTurn" as const,
      sessionKey: "agent:main:main",
      message: "generated image ready",
      messageId: "image:task-atomic:agent-loop",
      idempotencyKey: "image:task-atomic:agent-loop",
      completionRetention: "permanent" as const,
    };
    await withSessionDeliveryQueue(async (stateDir, queueContext) => {
      const claimed = await enqueueClaimedSessionDelivery(payload, 60_000, queueContext);
      await moveSessionDeliveryToFailed(claimed.id, queueContext);
      expect(getDeliveryQueueEntryStatus("session", claimed.id, stateDir)).toBe("failed");

      // The real update caller (releaseSessionDeliveryClaim) must fail closed on
      // the committed terminal row instead of resurrecting it for recovery.
      await expect(releaseSessionDeliveryClaim(claimed.id, queueContext)).rejects.toThrow(
        /No pending session delivery queue entry/,
      );

      expect(getDeliveryQueueEntryStatus("session", claimed.id, stateDir)).toBe("failed");
      expect(loadDeliveryQueueEntry("session", claimed.id, stateDir)).toBeNull();
    });
  });
});
