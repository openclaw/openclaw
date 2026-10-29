import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  prepareDeliveryQueueTerminalEntry,
  terminalizePendingDeliveryQueueEntryInDatabase,
  updateDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite.kernel.js";
import {
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntry,
  seedDeliveryQueueEntry,
} from "./delivery-queue-sqlite.test-support.js";
import type { DeliveryQueueEntryState } from "./delivery-queue-sqlite.types.js";
import { installDeliveryQueueTmpDirHooks } from "./outbound/delivery-queue.test-helpers.js";
import { createSqliteWalReclamationResult } from "./sqlite-wal-reclamation.js";

describe("delivery queue SQLite update atomicity", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const queueName = "test-update-atomicity";

  const enqueueRetained = (stateDir: string, id: string) =>
    seedDeliveryQueueEntry({
      queueName,
      entry: { id, enqueuedAt: Date.now(), retryCount: 0, retainOnFailure: true },
      stateDir,
    });

  const enqueueDeleted = (stateDir: string, id: string) =>
    seedDeliveryQueueEntry({
      queueName,
      entry: { id, enqueuedAt: Date.now(), retryCount: 0 },
      stateDir,
    });

  const runUpdate = (
    stateDir: string,
    id: string,
    update: (entry: DeliveryQueueEntryState) => DeliveryQueueEntryState,
  ) =>
    updateDeliveryQueueEntryInDatabase(
      openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }),
      queueName,
      id,
      update,
    );

  const terminalizeOnIndependentWriter = (
    stateDir: string,
    id: string,
    entry: DeliveryQueueEntryState,
  ) => {
    // A concurrent writer settles the row on its own committed connection
    // between the update's pending read and its write.
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    using rawWriter = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
    const writer: OpenClawStateDatabase = {
      db: rawWriter,
      path: resolveOpenClawStateSqlitePath(env),
      walMaintenance: {
        checkpoint: () => false,
        stop: async () => {},
        close: () => false,
        reclaimFreePages: createSqliteWalReclamationResult,
      },
    };
    return terminalizePendingDeliveryQueueEntryInDatabase(
      writer,
      prepareDeliveryQueueTerminalEntry({ queueName, id, entry }),
    );
  };

  it("fails closed when a concurrent retained terminalize lands inside the update window", () => {
    const stateDir = tmpDir();
    const id = "race-terminalize";
    enqueueRetained(stateDir, id);

    expect(() =>
      runUpdate(stateDir, id, (entry) => {
        expect(terminalizeOnIndependentWriter(stateDir, id, entry)).toEqual({
          status: "terminalized",
          retained: true,
        });
        return { ...entry, retryCount: 999, lastError: "stale" };
      }),
    ).toThrow(new RegExp(`No pending test-update-atomicity delivery queue entry ${id}`));

    // The independently committed terminal outcome survives the rejected update.
    expect(getDeliveryQueueEntryStatus(queueName, id, stateDir)).toBe("failed");
    expect(loadDeliveryQueueEntry(queueName, id, stateDir)).toBeNull();
  });

  it("fails closed when a concurrent deleting terminalize lands inside the update window", () => {
    const stateDir = tmpDir();
    const id = "race-deleted-terminalize";
    enqueueDeleted(stateDir, id);

    expect(() =>
      runUpdate(stateDir, id, (entry) => {
        // Without a retention fence the concurrent settlement deletes the row;
        // the pending-mode write must fail instead of INSERTing the stale row.
        expect(terminalizeOnIndependentWriter(stateDir, id, entry)).toEqual({
          status: "terminalized",
          retained: false,
        });
        return { ...entry, retryCount: 999, lastError: "stale" };
      }),
    ).toThrow(new RegExp(`No pending test-update-atomicity delivery queue entry ${id}`));

    // The deleted row is not resurrected as pending.
    expect(getDeliveryQueueEntryStatus(queueName, id, stateDir)).toBeUndefined();
    expect(loadDeliveryQueueEntry(queueName, id, stateDir)).toBeNull();
  });
});
