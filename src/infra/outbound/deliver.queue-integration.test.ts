import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import type {
  ChannelMessageDurableFinalAdapter,
  ChannelMessageSendResult,
  ChannelMessageSendTextContext,
} from "../../channels/message/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.test-support.js";
import { isOutboundDeliveryError, PlatformMessageNotDispatchedError } from "./deliver-types.js";
import { installQueueTestPlugin, matrixDeliveryResult } from "./deliver.custody.test-support.js";
import {
  boundedCronCompletionRetention,
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import { collectEntrySpoolPaths, stageQueuePayloadMedia } from "./delivery-queue-media-spool.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { recoverPendingDeliveries, type DeliverFn } from "./delivery-queue-recovery.js";
import {
  claimDeliveryPlatformSendAttempt,
  enqueueDeliveryOnce,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
  reserveDeliveryAttempt,
  type QueuedDelivery,
} from "./delivery-queue-storage.js";
import {
  loadPendingDeliveries,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

type DeliveryParams = Parameters<typeof deliverOutboundPayloads>[0];
function matrixRequest(params: Omit<DeliveryParams, "cfg" | "channel" | "to">): DeliveryParams {
  return { cfg: {}, channel: "matrix", to: "!room:example", ...params };
}
function deliverMatrix(params: Omit<DeliveryParams, "cfg" | "channel" | "to">) {
  return deliverOutboundPayloads(matrixRequest(params));
}

function installReconcilingTextTransport(
  sendText: (ctx: ChannelMessageSendTextContext) => Promise<ChannelMessageSendResult>,
) {
  const reconcileUnknownSend = vi
    .fn<NonNullable<ChannelMessageDurableFinalAdapter["reconcileUnknownSend"]>>()
    .mockResolvedValue({
      status: "unresolved",
      error: "provider lookup timed out",
      retryable: true,
    });
  installQueueTestPlugin({
    message: {
      id: "matrix",
      durableFinal: {
        capabilities: { text: true, reconcileUnknownSend: true },
        reconcileUnknownSendKinds: { text: true },
        reconcileUnknownSend,
      },
      send: { text: sendText },
    },
  });
  return reconcileUnknownSend;
}

describe("durable outbound queue delivery", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
        },
      ]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("never lets startup or reconnect impersonate a permanent live producer", async () => {
    const deliveryIntentId = "permanent-matrix-active-producer";
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "the original permanent producer owns this send" }],
        queuePolicy: "required",
        completionRetention: "permanent",
        requiresProducerClaim: true,
        maxRetries: 1,
      },
      deliveryIntentId,
      tmpDir,
    );
    const producerClaimId = await claimDeliveryPlatformSendAttempt(deliveryIntentId, tmpDir);
    if (!producerClaimId) {
      throw new Error("test invariant: permanent live producer must claim the stable row");
    }
    await reserveDeliveryAttempt(deliveryIntentId, 1, tmpDir, producerClaimId);
    const deliver = vi.fn<DeliverFn>(async () => []);

    await drainMatrixReconnect({ deliver, stateDir: tmpDir });
    await recoverPendingDeliveries({
      cfg: {} as OpenClawConfig,
      deliver,
      log: createRecoveryLog(),
      stateDir: tmpDir,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      id: deliveryIntentId,
      recoveryState: "producer_claimed",
      producerClaimId,
      attemptCount: 1,
    });
  });

  it("retains permanent receipts when stable delivery is intentionally suppressed", async () => {
    const sendMatrix = vi.fn();
    const liveIntentId = "permanent-matrix-suppressed-live";

    await expect(
      deliverMatrix({
        payloads: [{ text: "" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryIntentId: liveIntentId,
        completionRetention: "permanent",
        reusePendingDeliveryIntent: true,
      }),
    ).resolves.toEqual([]);
    expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, liveIntentId, tmpDir)).toBe(
      "completed",
    );

    const recoveryIntentId = "permanent-matrix-suppressed-recovery";
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "" }],
        queuePolicy: "required",
        completionRetention: "permanent",
      },
      recoveryIntentId,
      tmpDir,
    );
    await drainMatrixReconnect({ deliver: vi.fn<DeliverFn>(async () => []), stateDir: tmpDir });
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, recoveryIntentId, tmpDir),
    ).toBe("completed");
    expect(sendMatrix).not.toHaveBeenCalled();
  });

  it("never completes recovered Matrix batches when any platform send lacks an identity", async () => {
    const deliveryIntentId = "cron-direct-delivery:v1:recovered-matrix-partial-no-identity";
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "confirmed recipient message" }, { text: "ambiguous message" }],
        queuePolicy: "required",
        completionRetention: boundedCronCompletionRetention,
      },
      deliveryIntentId,
      tmpDir,
    );
    const sendMatrix = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "confirmed-recovered-message" })
      .mockResolvedValueOnce({});
    const deliver = vi.fn<DeliverFn>(async (params) =>
      deliverOutboundPayloads({ ...params, deps: { matrix: sendMatrix } }),
    );

    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(sendMatrix).toHaveBeenCalledTimes(2);
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      id: deliveryIntentId,
      recoveryState: "unknown_after_send",
      retryCount: 1,
    });
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("pending");

    await drainMatrixReconnect({ deliver, stateDir: tmpDir });
    expect(sendMatrix).toHaveBeenCalledTimes(2);
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).not.toBe("completed");
  });

  it("reuses durable Matrix media after regenerated producer files disappear", async () => {
    const deliveryIntentId = "cron-direct-delivery:v1:immutable-staged-matrix-media";
    const originalSource = path.join(tmpDir, "original-stable-media.ogg");
    const originalBytes = "original durable Matrix attachment";
    await fs.writeFile(originalSource, originalBytes);
    const staged = await stageQueuePayloadMedia({
      payloads: [{ text: "original queue-owned caption", mediaUrl: originalSource }],
      mediaAccess: { localRoots: [tmpDir] },
      maxBytes: 1024 * 1024,
      stateDir: tmpDir,
    });
    if (staged.status !== "staged") {
      throw new Error("test invariant: original producer media must be durably staged");
    }
    const spoolPath = staged.artifacts[0];
    if (!spoolPath) {
      throw new Error("test invariant: original media must have a queue-owned spool artifact");
    }
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: staged.payloads,
        queuePolicy: "required",
        completionRetention: boundedCronCompletionRetention,
      },
      deliveryIntentId,
      tmpDir,
      staged.mediaStageId,
    );
    const pending = (await loadPendingDeliveries(tmpDir))[0];
    expect(
      collectEntrySpoolPaths(
        pending
          ? acceptedPreparedOutboundEntries(pending.preparedBatch).map((entry) => entry.payload)
          : [],
        tmpDir,
      ),
    ).toEqual([spoolPath]);
    await fs.rm(originalSource);

    let deliveredBytes: string | undefined;
    const sendMatrix = vi.fn(
      async (_to: string, _text: string, options?: Record<string, unknown>) => {
        if (typeof options?.mediaUrl !== "string") {
          throw new Error("test invariant: Matrix must receive the original staged attachment");
        }
        deliveredBytes = await fs.readFile(options.mediaUrl, "utf8");
        return { messageId: "immutable-staged-matrix-message" };
      },
    );

    await expect(
      deliverMatrix({
        payloads: [
          {
            text: "regenerated caption must never replace queue custody",
            mediaUrl: path.join(tmpDir, "missing-regenerated-producer-media.ogg"),
          },
        ],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryIntentId,
        completionRetention: boundedCronCompletionRetention,
        reusePendingDeliveryIntent: true,
      }),
    ).resolves.toMatchObject([{ messageId: "immutable-staged-matrix-message" }]);

    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(sendMatrix).toHaveBeenCalledWith(
      "!room:example",
      "original queue-owned caption",
      expect.objectContaining({ mediaUrl: spoolPath }),
    );
    expect(deliveredBytes).toBe(originalBytes);
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("completed");
    await expect(fs.stat(spoolPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a completed stable receipt after fully successful best-effort delivery", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "stable-best-effort-message" });
    const deliveryIntentId = "cron-direct-delivery:v1:best-effort-stable-completion";
    const params = matrixRequest({
      payloads: [{ text: "best-effort send once" }],
      deps: { matrix: sendMatrix },
      bestEffort: true,
      queuePolicy: "best_effort" as const,
      deliveryIntentId,
      completionRetention: boundedCronCompletionRetention,
      reusePendingDeliveryIntent: true,
    });

    await expect(deliverOutboundPayloads(params)).resolves.toMatchObject([
      { messageId: "stable-best-effort-message" },
    ]);
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("completed");
    await expect(deliverOutboundPayloads(params)).resolves.toEqual([]);
    expect(sendMatrix).toHaveBeenCalledOnce();
  });

  it.each(["returned", "thrown"] as const)(
    "does not resend a final after a %s retryable reconciliation failure",
    async (failure) => {
      const deliveryIntentId = `cron-direct-delivery:v1:retryable-reconciliation-${failure}`;
      const visibleMessages: string[] = [];
      const sendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
        await ctx.onPlatformSendDispatch?.();
        visibleMessages.push(ctx.text);
        throw Object.assign(new Error("socket reset after acceptance"), { code: "ECONNRESET" });
      });
      const reconcileUnknownSend = installReconcilingTextTransport(sendText);
      if (failure === "thrown") {
        reconcileUnknownSend.mockRejectedValue(new Error("provider lookup timed out"));
      }
      const params = matrixRequest({
        payloads: [{ text: "Final answer already accepted" }],
        queuePolicy: "required",
        deliveryIntentId,
        completionRetention: boundedCronCompletionRetention,
        reusePendingDeliveryIntent: true,
        requireUnknownSendReconciliation: true,
        retryAmbiguousFinalText: true,
      });
      await expect(deliverOutboundPayloads(params)).rejects.toThrow("socket reset");
      expect(visibleMessages).toEqual(["Final answer already accepted"]);
      expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
        id: deliveryIntentId,
        recoveryState: "unknown_after_send",
        attemptCount: 1,
        lastError: expect.stringContaining("provider lookup timed out"),
      });

      reconcileUnknownSend.mockResolvedValue({
        status: "sent",
        ...matrixDeliveryResult("original-platform-message"),
      });
      await drainMatrixReconnect({ deliver: deliverOutboundPayloads, stateDir: tmpDir });
      expect(reconcileUnknownSend).toHaveBeenCalledTimes(2);
      expect(sendText).toHaveBeenCalledOnce();
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
      ).toBe("completed");
      await expect(deliverOutboundPayloads(params)).resolves.toEqual([]);
      expect(sendText).toHaveBeenCalledOnce();
    },
  );

  it.each([
    // At retry 2, proof can spend a third slot, but it cannot create one.
    ["send_attempt_started", 3, [5_000, 25_000], "completed"],
    ["send_attempt_started", 2, [5_000, 25_000], "failed"],
    // Even with a slot left, not_sent cannot override stronger post-send evidence.
    ["unknown_after_send", 2, [5_000], "failed"],
  ] as const)(
    "settles a late not_sent for %s (budget %i, backoff %j) as %s",
    async (state, maxRetries, delays, status) => {
      const id = "cron-direct-delivery:v1:late-not-sent";
      const text = "Saved final answer";
      await enqueueDeliveryOnce(
        {
          channel: "matrix",
          to: "!room:example",
          payloads: [{ text }],
          completionRetention: boundedCronCompletionRetention,
          retryAmbiguousFinalText: true,
          maxRetries,
        },
        id,
        tmpDir,
      );
      const claim = await claimDeliveryPlatformSendAttempt(id, tmpDir);
      assert(claim);
      await reserveDeliveryAttempt(id, maxRetries, tmpDir, claim);
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir, undefined, claim);
      if (state === "unknown_after_send") {
        await markDeliveryPlatformOutcomeUnknown(id, tmpDir, claim);
      }
      let dispatched: QueuedDelivery | undefined;
      const sendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
        assert(ctx.onPlatformSendDispatch);
        await ctx.onPlatformSendDispatch();
        [dispatched] = await loadPendingDeliveries(tmpDir);
        return matrixDeliveryResult("recovered-message");
      });
      const reconcileUnknownSend = installReconcilingTextTransport(sendText);
      const recover = () =>
        recoverPendingDeliveries({
          cfg: {},
          stateDir: tmpDir,
          log: createRecoveryLog(),
          deliver: deliverOutboundPayloads,
        });
      // The worker timestamps failures on the wall clock; only the recovery scheduler moves ahead.
      const wallNow = Date.now;
      using clock = vi.spyOn(Date, "now");
      for (const [i, delay] of delays.entries()) {
        const lookupStartedAt = wallNow();
        await recover();
        expect(sendText).not.toHaveBeenCalled();
        const [pending] = await loadPendingDeliveries(tmpDir);
        expect(pending).toMatchObject({
          id,
          recoveryState: state,
          retryCount: i + 1,
          attemptCount: 1,
          maxRetries,
        });
        assert(pending?.lastAttemptAt !== undefined);
        expect(pending.lastAttemptAt).toBeGreaterThanOrEqual(lookupStartedAt);
        expect(pending.lastAttemptAt).toBeLessThanOrEqual(wallNow());
        const due = pending.lastAttemptAt + delay;
        clock.mockReturnValue(due - 1);
        expect((await recover()).deferredBackoff).toBe(1);
        expect(reconcileUnknownSend).toHaveBeenCalledTimes(i + 1);
        clock.mockReturnValue(due);
      }
      reconcileUnknownSend.mockResolvedValue({ status: "not_sent" });
      await recover();
      expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir)).toBe(status);
      // Terminal custody is not eligible for another lookup or another dispatch.
      await recover();
      expect(reconcileUnknownSend).toHaveBeenCalledTimes(delays.length + 1);
      expect(sendText).toHaveBeenCalledTimes(status === "completed" ? 1 : 0);
      if (status === "completed") {
        expect(dispatched).toMatchObject({
          id,
          attemptCount: 3,
          retryCount: 2,
          recoveryState: "send_attempt_started",
          platformSendAttemptId: expect.any(String),
        });
        expect(dispatched?.platformSendAttemptId).not.toBe(claim);
        expect(sendText).toHaveBeenCalledWith(
          expect.objectContaining({ text, to: "!room:example" }),
        );
      }
    },
  );

  it("holds one live claim while concurrent producers reuse a stable pending intent", async () => {
    let resolveSend!: (value: { messageId: string }) => void;
    const { promise: sendStarted, resolve: notifySendStarted } = createDeferred();
    const sendMatrix = vi.fn(
      () =>
        new Promise<{ messageId: string }>((resolve) => {
          resolveSend = resolve;
          notifySendStarted();
        }),
    );
    const deliveryIntentId = "cron-direct-delivery:v1:concurrent-stable-completion";
    const params = matrixRequest({
      payloads: [{ text: "send exactly once" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required" as const,
      deliveryIntentId,
      completionRetention: boundedCronCompletionRetention,
      reusePendingDeliveryIntent: true,
    });

    const first = deliverOutboundPayloads(params);
    await sendStarted;
    const recoveryDeliver = vi.fn<DeliverFn>(async () => []);
    await drainMatrixReconnect({ deliver: recoveryDeliver, stateDir: tmpDir });
    expect(recoveryDeliver).not.toHaveBeenCalled();
    expect(sendMatrix).toHaveBeenCalledOnce();
    const concurrentReplay = deliverOutboundPayloads(params);
    expect(sendMatrix).toHaveBeenCalledOnce();
    resolveSend({ messageId: "concurrent-stable-message" });
    await expect(first).resolves.toMatchObject([{ messageId: "concurrent-stable-message" }]);
    await expect(concurrentReplay).resolves.toEqual([]);
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("completed");
  });

  it("never acknowledges route-only metadata as a platform message identity", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "", toJid: "!route-only:example" });
    const deliveryIntentId = "cron-direct-delivery:v1:no-platform-identity";
    const params = matrixRequest({
      payloads: [{ text: "provider returned no message identity" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required" as const,
      deliveryIntentId,
      completionRetention: boundedCronCompletionRetention,
      reusePendingDeliveryIntent: true,
    });

    await expect(deliverOutboundPayloads(params)).resolves.toEqual([]);
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("pending");
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      id: deliveryIntentId,
      recoveryState: "unknown_after_send",
    });
    await expect(deliverOutboundPayloads(params)).rejects.toThrow(
      `Stable delivery intent is already queued: ${deliveryIntentId}`,
    );
    expect(sendMatrix).toHaveBeenCalledOnce();
  });

  it("never completes live Matrix batches when any platform send lacks an identity", async () => {
    const sendMatrix = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "confirmed-live-message" })
      .mockResolvedValueOnce({});
    const deliveryIntentId = "cron-direct-delivery:v1:live-matrix-partial-no-identity";
    const params = matrixRequest({
      payloads: [{ text: "confirmed recipient message" }, { text: "ambiguous message" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required" as const,
      deliveryIntentId,
      completionRetention: boundedCronCompletionRetention,
      reusePendingDeliveryIntent: true,
    });

    await expect(deliverOutboundPayloads(params)).rejects.toThrow(
      "platform send returned no delivery identity for part of the delivery batch",
    );
    expect(sendMatrix).toHaveBeenCalledTimes(2);
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      id: deliveryIntentId,
      recoveryState: "unknown_after_send",
      retryCount: 1,
    });
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("pending");

    await expect(deliverOutboundPayloads(params)).rejects.toThrow(
      `Stable delivery intent is already queued: ${deliveryIntentId}`,
    );
    expect(sendMatrix).toHaveBeenCalledTimes(2);
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).not.toBe("completed");
  });

  it("removes an unsent queue intent when the caller cancels after publication", async () => {
    const controller = new AbortController();
    const sendMatrix = vi.fn();

    await expect(
      deliverMatrix({
        payloads: [{ text: "cancel before provider dispatch" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        abortSignal: controller.signal,
        onDeliveryIntent: () =>
          controller.abort(new DOMException("Operator cancelled delivery", "AbortError")),
      }),
    ).rejects.toMatchObject({ message: "Operation aborted", queueCustody: "released" });

    expect(sendMatrix).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
  });

  it("retries a stable delivery intent only after a proven pre-dispatch failure", async () => {
    const notDispatchedError = new PlatformMessageNotDispatchedError(
      "provider disconnected before dispatch",
      { cause: new Error("connect ECONNREFUSED") },
    );
    const sendMatrix = vi
      .fn()
      .mockRejectedValueOnce(notDispatchedError)
      .mockResolvedValueOnce({ messageId: "recovered-stable-message" });
    const deliveryIntentId = "cron-direct-delivery:v1:safe-retry";
    const params = matrixRequest({
      payloads: [{ text: "safe retry" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required" as const,
      deliveryIntentId,
      completionRetention: boundedCronCompletionRetention,
      reusePendingDeliveryIntent: true,
    });

    await expect(deliverOutboundPayloads(params)).rejects.toThrow(
      "provider disconnected before dispatch",
    );
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      id: deliveryIntentId,
      retryCount: 1,
    });
    expect((await loadPendingDeliveries(tmpDir))[0]?.recoveryState).toBeUndefined();
    await expect(deliverOutboundPayloads(params)).resolves.toMatchObject([
      { messageId: "recovered-stable-message" },
    ]);
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("completed");
    expect(sendMatrix).toHaveBeenCalledTimes(2);
  });

  it("does not retain a pre-send suppression across an ambiguous crash boundary", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const sendMatrix = vi.fn().mockRejectedValueOnce(new Error("ambiguous provider failure"));

    await expect(
      deliverMatrix({
        payloads: [{ text: "NO_REPLY" }, { text: "visible" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("ambiguous provider failure");

    const beforeDrain = await loadPendingDeliveries(tmpDir);
    expect(beforeDrain).toHaveLength(1);
    expect(beforeDrain[0]?.recoveryState).toBe("unknown_after_send");

    const deliver = vi.fn<DeliverFn>(async () => {});
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });
    unsubscribe();

    expect(deliver).not.toHaveBeenCalled();
    expect(auditEvents.map((event) => event.outcome)).toEqual([
      "queued",
      "queued",
      "platform_started",
      "unknown",
      "unknown",
    ]);
    expect(auditEvents.slice(-2).map((event) => event.resultCount)).toEqual([0, 0]);
  });

  const attemptProvenNotSentSend = async (
    error: Error,
    thrown: string,
    extra: Partial<Parameters<typeof deliverOutboundPayloads>[0]>,
  ) => {
    const failure = await deliverMatrix({
      payloads: [{ text: "first" }],
      deps: { matrix: vi.fn().mockRejectedValueOnce(error) },
      queuePolicy: "required",
      ...extra,
    }).catch((caught: unknown) => caught);
    expect(failure).toMatchObject({ message: expect.stringContaining(thrown) });
    return failure;
  };

  const connectRefusedError = () =>
    Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      syscall: "connect",
    });

  it.each([["a proven pre-connect failure", connectRefusedError(), "ECONNREFUSED"]])(
    "dead-letters a caller-owned entry after %s",
    async (_label, error, thrown) => {
      const failure = await attemptProvenNotSentSend(error, thrown, {
        deliveryRetryOwner: "caller",
      });
      expect(isOutboundDeliveryError(failure) && failure.queueCustody).toBe("released");

      // The caller received the proven-not-sent error and owns the retry; a
      // pending row here is what produced duplicate sends (#124279).
      expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);

      const recoverySendMatrix = vi.fn();
      const deliver = vi.fn<DeliverFn>(async (params) =>
        deliverOutboundPayloads({ ...params, deps: { matrix: recoverySendMatrix } }),
      );
      await drainMatrixReconnect({ deliver, stateDir: tmpDir });

      expect(deliver).not.toHaveBeenCalled();
      expect(recoverySendMatrix).not.toHaveBeenCalled();
    },
  );

  it.each([["a caller that only reports the failure", {}]])(
    "replays %s after a proven pre-connect failure clears send evidence",
    async (_label, extra) => {
      const failure = await attemptProvenNotSentSend(connectRefusedError(), "ECONNREFUSED", extra);
      expect(isOutboundDeliveryError(failure) && failure.queueCustody).toBe("held");

      // Neither entry has a caller that resends: reusable intents belong to the
      // queue, and CLI/RPC callers only report the error. Both must stay pending
      // with cleared send evidence so recovery can replay them (#100979).
      const beforeDrain = await loadPendingDeliveries(tmpDir);
      expect(beforeDrain).toHaveLength(1);
      expect(beforeDrain[0]).toMatchObject({
        retryCount: 1,
        lastError: expect.stringContaining("ECONNREFUSED"),
      });
      expect(beforeDrain[0]?.recoveryState).toBeUndefined();
      expect(beforeDrain[0]?.platformSendStartedAt).toBeUndefined();

      const recoverySendMatrix = vi.fn().mockResolvedValueOnce({ messageId: "recovered" });
      const deliver = vi.fn<DeliverFn>(async (params) =>
        deliverOutboundPayloads({ ...params, deps: { matrix: recoverySendMatrix } }),
      );
      await drainMatrixReconnect({ deliver, stateDir: tmpDir });

      expect(deliver).toHaveBeenCalledOnce();
      expect(recoverySendMatrix).toHaveBeenCalledOnce();
      expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
    },
  );
});
