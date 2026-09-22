import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureDeliveryQueueStateContext } from "../delivery-queue-sqlite.js";
import { createQueuedDeliveryOwner } from "./deliver-queue-state.js";
import { ackDelivery } from "./delivery-queue-ack.js";
import { holdAcknowledgementReply } from "./delivery-queue-ack.worker.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-namespaces.js";
import type { AckDeliveryOptions } from "./delivery-queue-settlement.types.js";
import {
  claimDeliveryPlatformSendAttempt,
  enqueueDelivery,
  enqueueDeliveryOnce,
  loadPendingDelivery,
} from "./delivery-queue-storage.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

describe("outbound acknowledgement worker", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("settles the exact queue owner without host data SQL, including a cold reopen", async () => {
    const stateDir = fixtures.tmpDir();
    const id = await enqueueDelivery(
      { channel: "matrix", to: "!synthetic:example", payloads: [{ text: "settled" }] },
      stateDir,
    );
    const claimId = await claimDeliveryPlatformSendAttempt(id, stateDir);
    expect(claimId).toEqual(expect.any(String));
    await closeOpenClawStateDatabaseAsync();
    const context = captureDeliveryQueueStateContext(stateDir);
    const owner = createQueuedDeliveryOwner(
      { queueId: id, expectedPlatformSendAttemptId: claimId },
      context,
    );
    const sql = observeHostDataSql({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
    try {
      await owner.ack();
      expect(owner.custody).toBe("released");
      expect(sql.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      sql.restore();
      await closeOpenClawStateDatabaseAsync();
    }
    expect(await loadPendingDelivery(id, stateDir)).toBeNull();
  });

  it.each([null, undefined])(
    "preserves explicit %s owner checks across worker transfer",
    async (expectedPlatformSendAttemptId) => {
      const stateDir = fixtures.tmpDir();
      const id = await enqueueDelivery(
        { channel: "matrix", to: "!synthetic:example", payloads: [{ text: "retained" }] },
        stateDir,
      );
      const claimId = await claimDeliveryPlatformSendAttempt(id, stateDir);
      await expect(ackDelivery(id, stateDir, { expectedPlatformSendAttemptId })).rejects.toThrow(
        `Delivery platform claim was lost: ${id}`,
      );
      expect(await loadPendingDelivery(id, stateDir)).toMatchObject({ producerClaimId: claimId });
      await ackDelivery(id, stateDir, { expectedPlatformSendAttemptId: claimId });
      expect(await loadPendingDelivery(id, stateDir)).toBeNull();
      await expect(ackDelivery(id, stateDir, { expectedPlatformSendAttemptId })).rejects.toThrow(
        `Delivery platform claim was lost: ${id}`,
      );
      await expect(ackDelivery(id, stateDir)).resolves.toBeUndefined();
    },
  );
  it("captures ACK facts before admission and settles an expired exact owner before media cleanup", async () => {
    const stateDir = fixtures.tmpDir();
    const id = "captured-expired-ack";
    const artifact = path.join(
      stateDir,
      "delivery-queue-media",
      "00000000-0000-4000-8000-000000000001.ogg",
    );
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, "synthetic audio");
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!synthetic:example",
        payloads: [{ mediaUrl: artifact }],
        completionRetention: "permanent",
      },
      id,
      stateDir,
    );
    const claimId = await claimDeliveryPlatformSendAttempt(id, stateDir);
    const entry = await loadPendingDelivery(id, stateDir);
    if (!claimId || !entry) {
      throw new Error("Expected a claimed queue entry");
    }
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const reply = holdAcknowledgementReply(id);
    const options: AckDeliveryOptions = {
      expectedPlatformSendAttemptId: claimId,
      suppressCompletionReceipt: true,
      retainSpoolArtifacts: false,
    };
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    db.exec("BEGIN IMMEDIATE");
    let settled = false;
    const ack = ackDelivery(id, undefined, options).finally(() => {
      settled = true;
    });
    options.expectedPlatformSendAttemptId = "replacement";
    options.suppressCompletionReceipt = false;
    options.retainSpoolArtifacts = true;
    const otherState = path.join(stateDir, "other-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", otherState);
    try {
      await Promise.race([
        reply.posted,
        ack.then(() => {
          throw new Error("ACK settled before worker dispatch");
        }),
      ]);
      await setImmediate();
      expect(settled).toBe(false);
      db.prepare(
        "UPDATE delivery_queue_entries SET entry_json = ? WHERE queue_name = ? AND id = ?",
      ).run(
        JSON.stringify({ ...entry, availableAt: Date.now() - 1 }),
        OUTBOUND_DELIVERY_QUEUE_NAME,
        id,
      );
      db.exec("COMMIT");
      expect(
        await Promise.race([
          reply.held,
          ack.then(() => {
            throw new Error("ACK settled without its reply");
          }),
        ]),
      ).toEqual([artifact]);
      expect(settled).toBe(false);
      await expect(fs.readFile(artifact, "utf8")).resolves.toBe("synthetic audio");
      expect(
        db.prepare("SELECT id FROM delivery_queue_entries WHERE id = ?").get(id),
      ).toBeUndefined();
      reply.release();
      await ack;
      await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(otherState)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      reply.restore();
      reply.release();
      await ack;
    }
  });
});
