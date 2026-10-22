import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { stateWorkerRegistry } from "../../state/openclaw-state-worker-registry.js";
import type { WorkerWriteOperationContext } from "../../state/worker-operation-registry.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { captureDeliveryQueueStateContext } from "../delivery-queue-sqlite.js";
import { seedDeliveryQueueEntry } from "../delivery-queue-sqlite.test-support.js";
import { ackDelivery } from "./delivery-queue-ack.js";
import { startDeliveryProducerLease } from "./delivery-queue-lease.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-namespaces.js";
import {
  claimReusableDeliveryPlatformSendAttempt,
  renewDeliveryPlatformSendLease,
} from "./delivery-queue-platform-lease.js";
import {
  enqueueDelivery,
  enqueueDeliveryOnce,
  markDeliveryPlatformSendAttemptStarted,
  markDeliveryPlatformSendDispatched,
  loadPendingDelivery,
} from "./delivery-queue-storage.js";
import { holdDeliveryQueueReply } from "./delivery-queue-worker-reply.test-support.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

function beforeSettlement<T>(signal: Promise<T>, operation: Promise<unknown>) {
  return Promise.race([
    signal,
    operation.then(() => assert.fail("Worker operation settled before its expected signal")),
  ]);
}

function observeRenewalDispatch(id: string, holdReply = false) {
  return holdDeliveryQueueReply("deliveryQueue.renewPlatformSendLease", id, (value) =>
    holdReply && typeof value === "number" ? value : undefined,
  );
}

describe("outbound producer claim worker", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const payload = { channel: "matrix", to: "!synthetic:example", payloads: [{ text: "test" }] };
  async function claimRetained(id: string, stateDir: string) {
    await enqueueDeliveryOnce(payload, id, stateDir);
    const claimId = await claimReusableDeliveryPlatformSendAttempt(id, stateDir);
    assert(claimId, "Expected claimed queue custody");
    return claimId;
  }

  it("refreshes the attempt timestamp immediately before provider I/O", async () => {
    const id = await enqueueDelivery(payload, fixtures.tmpDir());

    await stateWorkerRegistry.prepare("deliveryQueue.mutateOutbound");
    vi.useFakeTimers();
    try {
      const env = { ...process.env, OPENCLAW_STATE_DIR: fixtures.tmpDir() };
      const database = openOpenClawStateDatabase({ env });
      const context: WorkerWriteOperationContext = {
        open: () => database,
        writeAdmitted: () => assert.fail("Outbound mutations retain their custom admission"),
        write: (operation, options) =>
          runOpenClawStateWriteTransaction(operation, { database, env }, options),
        stateOptions: () => ({ path: database.path, env }),
      };
      for (const [time, kind] of [
        [1_000, "start"],
        [9_000, "dispatch"],
      ] as const) {
        vi.setSystemTime(time);
        stateWorkerRegistry.execute(
          { type: "deliveryQueue.mutateOutbound", input: { kind, id } },
          context,
        );
      }
    } finally {
      vi.useRealTimers();
    }

    const entry = await loadPendingDelivery(id, fixtures.tmpDir());
    expect(entry).toMatchObject({
      platformSendStartedAt: 9_000,
      recoveryState: "send_attempt_started",
    });
  });

  it("transfers only reply metadata from the actual callback-bearing send context", async () => {
    const stateDir = fixtures.tmpDir();
    const id = await enqueueDelivery(payload, stateDir);
    const localGuard = vi.fn();
    const route = {
      replyToId: "reply",
      threadId: "thread",
      assertDirectAdapterHandoff: localGuard,
    };
    await markDeliveryPlatformSendAttemptStarted(id, stateDir, route);
    expect(await loadPendingDelivery(id, stateDir)).toMatchObject({
      effectiveReplyToId: "reply",
      recoveryState: "send_attempt_started",
    });
    await markDeliveryPlatformSendDispatched(id, stateDir, { ...route, replyToId: null });
    expect(await loadPendingDelivery(id, stateDir)).toMatchObject({
      effectiveReplyToId: null,
      recoveryState: "send_attempt_started",
    });
    expect(localGuard).not.toHaveBeenCalled();
  });

  it("claims and renews retained custody without host data SQL, then reopens the same owner", async () => {
    const stateDir = fixtures.tmpDir();
    const id = "worker-claim";
    await enqueueDeliveryOnce(payload, id, stateDir);
    await closeOpenClawStateDatabaseAsync();
    const context = captureDeliveryQueueStateContext(stateDir);
    const sql = observeHostDataSql();
    let claimId: string | undefined;
    let expiresAt: number | undefined;
    try {
      const claims = await Promise.all([
        claimReusableDeliveryPlatformSendAttempt(id, undefined, context),
        claimReusableDeliveryPlatformSendAttempt(id, undefined, context),
      ]);
      claimId = claims[0];
      expect(claims[1]).toBeUndefined();
      expect(claimId).toEqual(expect.any(String));
      assert(claimId, "Expected the unclaimed queue row to acquire an owner");
      expiresAt = await renewDeliveryPlatformSendLease(id, undefined, claimId, context);
      expect(expiresAt).toBeGreaterThan(Date.now());
      expect(sql.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      sql.restore();
      await closeOpenClawStateDatabaseAsync();
    }
    expect(await loadPendingDelivery(id, stateDir)).toMatchObject({
      id,
      producerClaimId: claimId,
      availableAt: expiresAt,
      requiresProducerClaim: true,
      recoveryState: "producer_claimed",
      retryCount: 0,
      attemptCount: 0,
    });
  });

  it("rereads lease expiry after a real writer wait while the host remains responsive", async () => {
    const stateDir = fixtures.tmpDir();
    const id = "expired-during-writer-wait";
    const claimId = await claimRetained(id, stateDir);
    const entry = await loadPendingDelivery(id, stateDir);
    assert(entry, "Expected claimed queue custody");
    const db = requireNativeSqliteDatabase(
      openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }).db,
    );
    const dispatch = observeRenewalDispatch(id);
    db.exec("BEGIN IMMEDIATE");
    let settled = false;
    const renewal = renewDeliveryPlatformSendLease(id, stateDir, claimId).finally(() => {
      settled = true;
    });
    try {
      await beforeSettlement(dispatch.posted, renewal);
      await setImmediate();
      expect(settled).toBe(false);
      const expired = { ...entry, availableAt: Date.now() - 1 };
      seedDeliveryQueueEntry({ queueName: OUTBOUND_DELIVERY_QUEUE_NAME, entry: expired, stateDir });
      db.exec("COMMIT");
      await expect(renewal).resolves.toBeUndefined();
      expect(await loadPendingDelivery(id, stateDir)).toEqual(expired);
    } finally {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      await renewal.catch(() => undefined);
    }
  });

  it("joins an accepted renewal before lease stop permits acknowledgement", async () => {
    const stateDir = fixtures.tmpDir();
    const id = "joined-worker-renewal";
    const claimId = await claimRetained(id, stateDir);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const renew = vi.fn(() => renewDeliveryPlatformSendLease(id, stateDir, claimId));
    const lease = await startDeliveryProducerLease({ id, renew });
    const dispatch = observeRenewalDispatch(id, true);
    let cleanup: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(renew).toHaveBeenCalledTimes(2);
      const result = renew.mock.results.at(-1);
      assert(result?.type === "return", "Expected an admitted renewal");
      const expiresAt = await beforeSettlement(dispatch.held, result.value);
      let acknowledged = false;
      cleanup = lease.stop().then(async () => {
        await ackDelivery(id, stateDir, { expectedPlatformSendAttemptId: claimId });
        acknowledged = true;
      });
      await setImmediate();
      expect(acknowledged).toBe(false);
      expect(await loadPendingDelivery(id, stateDir)).toMatchObject({
        producerClaimId: claimId,
        availableAt: expiresAt,
      });
      dispatch.release();
      await cleanup;
      expect(await renewDeliveryPlatformSendLease(id, stateDir, claimId)).toBeUndefined();
      expect(await loadPendingDelivery(id, stateDir)).toBeNull();
    } finally {
      dispatch.release();
      await lease.stop();
      await cleanup;
      vi.useRealTimers();
    }
  });
});
