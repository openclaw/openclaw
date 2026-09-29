import { setImmediate } from "node:timers/promises";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureDeliveryQueueStateContext } from "../delivery-queue-sqlite.js";
import type { SqliteWorkerRequest } from "../sqlite-worker-contract.js";
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
import { executeOutboundDeliveryStorageCommand } from "./delivery-queue-storage.worker.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

function observeRenewalDispatch(id: string) {
  const posted = createDeferredCore();
  let target: { worker: Worker; requestId: number } | undefined;
  // oxlint-disable-next-line typescript/unbound-method -- call supplies the intercepted worker receiver.
  const original = Worker.prototype.postMessage;
  const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request: SqliteWorkerRequest,
    transferList,
  ) {
    if (request.type === "execute") {
      const command: unknown = deserialize(request.input);
      if (
        isRecord(command) &&
        command.type === "deliveryQueue.renewPlatformSendLease" &&
        isRecord(command.input) &&
        command.input.id === id
      ) {
        target = { worker: this, requestId: request.id };
        posted.resolve();
      }
    }
    return original.call(this, request, transferList);
  });
  return { posted: posted.promise, target: () => target, restore: () => post.mockRestore() };
}

describe("outbound producer claim worker", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("refreshes the attempt timestamp immediately before provider I/O", async () => {
    const id = await enqueueDelivery(
      {
        channel: "forum",
        to: "123",
        payloads: [{ text: "test" }],
      },
      fixtures.tmpDir(),
    );

    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const env = { ...process.env, OPENCLAW_STATE_DIR: fixtures.tmpDir() };
      const options = { database: openOpenClawStateDatabase({ env }), env };
      executeOutboundDeliveryStorageCommand(
        { type: "deliveryQueue.mutateOutbound", input: { kind: "start", id } },
        options,
      );
      vi.setSystemTime(9_000);
      executeOutboundDeliveryStorageCommand(
        { type: "deliveryQueue.mutateOutbound", input: { kind: "dispatch", id } },
        options,
      );
    } finally {
      vi.useRealTimers();
    }

    const entry = await loadPendingDelivery(id, fixtures.tmpDir());
    expect(entry?.platformSendStartedAt).toBe(9_000);
    expect(entry?.recoveryState).toBe("send_attempt_started");
  });

  it("transfers only reply metadata from the actual callback-bearing send context", async () => {
    const stateDir = fixtures.tmpDir();
    const id = await enqueueDelivery(
      { channel: "matrix", to: "!synthetic:example", payloads: [{ text: "ordinary result" }] },
      stateDir,
    );
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
    await enqueueDeliveryOnce(
      { channel: "matrix", to: "!synthetic:example", payloads: [{ text: "retained" }] },
      id,
      stateDir,
    );
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
      if (!claimId) {
        throw new Error("Expected the unclaimed queue row to acquire an owner");
      }
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
    await enqueueDeliveryOnce(
      { channel: "matrix", to: "!synthetic:example", payloads: [{ text: "retained" }] },
      id,
      stateDir,
    );
    const claimId = await claimReusableDeliveryPlatformSendAttempt(id, stateDir);
    const entry = await loadPendingDelivery(id, stateDir);
    if (!claimId || !entry) {
      throw new Error("Expected claimed queue custody");
    }
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const dispatch = observeRenewalDispatch(id);
    db.exec("BEGIN IMMEDIATE");
    let settled = false;
    const renewal = renewDeliveryPlatformSendLease(id, stateDir, claimId).finally(() => {
      settled = true;
    });
    try {
      await Promise.race([
        dispatch.posted,
        renewal.then(() => {
          throw new Error("Renewal settled before entering its worker");
        }),
      ]);
      await setImmediate();
      expect(settled).toBe(false);
      const expired = { ...entry, availableAt: Date.now() - 1 };
      db.prepare(
        "UPDATE delivery_queue_entries SET entry_json = ? WHERE queue_name = ? AND id = ?",
      ).run(JSON.stringify(expired), OUTBOUND_DELIVERY_QUEUE_NAME, id);
      db.exec("COMMIT");
      await expect(renewal).resolves.toBeUndefined();
      expect(await loadPendingDelivery(id, stateDir)).toEqual(expired);
    } finally {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      dispatch.restore();
      await renewal.catch(() => undefined);
    }
  });

  it("joins an accepted renewal before lease stop permits acknowledgement", async () => {
    const stateDir = fixtures.tmpDir();
    const id = "joined-worker-renewal";
    await enqueueDeliveryOnce(
      { channel: "matrix", to: "!synthetic:example", payloads: [{ text: "retained" }] },
      id,
      stateDir,
    );
    const claimId = await claimReusableDeliveryPlatformSendAttempt(id, stateDir);
    if (!claimId) {
      throw new Error("Expected claimed queue custody");
    }
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const renew = vi.fn(() => renewDeliveryPlatformSendLease(id, stateDir, claimId));
    const lease = await startDeliveryProducerLease({ id, renew });
    const dispatch = observeRenewalDispatch(id);
    const held = createDeferredCore<number>();
    let publish: (() => void) | undefined;
    let captured = false;
    const release = () => {
      const send = publish;
      publish = undefined;
      send?.();
    };
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply supplies the emitting worker receiver.
    const original = Worker.prototype.emit;
    const messages = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
      this: Worker,
      event: string | symbol,
      ...args: unknown[]
    ) {
      const target = dispatch.target();
      const reply = args[0];
      if (
        !captured &&
        target?.worker === this &&
        event === "message" &&
        isRecord(reply) &&
        reply.id === target.requestId &&
        reply.ok === true &&
        reply.value instanceof Uint8Array
      ) {
        const expiresAt: unknown = deserialize(reply.value);
        if (typeof expiresAt === "number") {
          captured = true;
          publish = () => {
            Reflect.apply(original, this, [event, ...args]);
          };
          held.resolve(expiresAt);
          return true;
        }
      }
      return Reflect.apply(original, this, [event, ...args]);
    });
    let cleanup: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(renew).toHaveBeenCalledTimes(2);
      const result = renew.mock.results.at(-1);
      if (!result || result.type !== "return") {
        throw new Error("Expected an admitted renewal");
      }
      const expiresAt = await Promise.race([
        held.promise,
        result.value.then(() => {
          throw new Error("Renewal settled without its held result");
        }),
      ]);
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
      release();
      await cleanup;
      expect(await renewDeliveryPlatformSendLease(id, stateDir, claimId)).toBeUndefined();
      expect(await loadPendingDelivery(id, stateDir)).toBeNull();
    } finally {
      messages.mockRestore();
      dispatch.restore();
      release();
      await lease.stop();
      await cleanup;
      vi.useRealTimers();
    }
  });
});
