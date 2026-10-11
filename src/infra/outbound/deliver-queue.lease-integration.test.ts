import { setImmediate } from "node:timers/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { onTrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelMessageSendTextContext } from "../../channels/message/types.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.test-support.js";
import {
  boundedCronCompletionRetention,
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import * as platformLease from "./delivery-queue-platform-lease.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import { claimDeliveryPlatformSendAttempt, enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  installDeliveryQueueTmpDirHooks,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

// Lease ownership is independent of destination transcript persistence.
vi.mock("../../sessions/confirmed-visible-message.js", () => ({
  commitConfirmedVisibleMessage: vi.fn(async () => ({ ok: true })),
}));

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

function useLeaseHeartbeatTimers() {
  // Worker leases use the real clock; only drive the host heartbeat scheduler.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const renew = vi.spyOn(platformLease, "renewDeliveryPlatformSendLease");
  return async () => {
    const previousCalls = renew.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(renew).toHaveBeenCalledTimes(previousCalls + 1);
    const renewal = renew.mock.results.at(-1);
    if (!renewal || renewal.type !== "return") {
      throw new Error("Expected an accepted producer lease renewal");
    }
    const expiresAt = await renewal.value;
    // Let the lease owner consume the storage result before releasing the adapter.
    await setImmediate();
    return expiresAt;
  };
}

async function startBlockedDelivery(params: {
  tmpDir: string;
  deliveryIntentId?: string;
  requiresProducerClaim?: boolean;
  phase?: "preparation" | "presentation" | "provider";
}) {
  process.env.OPENCLAW_STATE_DIR = params.tmpDir;
  const phase = params.phase ?? "preparation";
  const entered = createDeferred();
  const release = createDeferred();
  const queueIdReady = createDeferred<string>();
  const messageId = params.deliveryIntentId
    ? `${params.deliveryIntentId}-message`
    : "fresh-live-message";
  const hold = async () => {
    entered.resolve();
    await release.promise;
  };
  const renderPresentation = vi.fn<NonNullable<ChannelOutboundAdapter["renderPresentation"]>>(
    async ({ payload }) => {
      await hold();
      return payload;
    },
  );
  const onDeliveryResult = vi.fn();
  const sendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
    await ctx.onPlatformSendDispatch?.();
    if (phase === "provider") {
      await hold();
    }
    return {
      messageId,
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "matrix", messageId }],
        kind: "text",
      }),
    };
  });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              ...matrixOutboundForQueueTest,
              ...(phase === "presentation"
                ? { presentationCapabilities: { supported: true }, renderPresentation }
                : {}),
            },
          }),
          message: {
            id: "matrix",
            durableFinal: { capabilities: { text: true } },
            send: {
              ...(phase === "preparation" ? { lifecycle: { beforeSendAttempt: hold } } : {}),
              text: sendText,
            },
          },
        },
      },
    ]),
  );
  if (params.deliveryIntentId) {
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [
          {
            text: "queue-owned stable content",
            ...(phase === "presentation"
              ? {
                  presentation: {
                    blocks: [{ type: "text" as const, text: "rendered stable content" }],
                  },
                }
              : {}),
          },
        ],
        queuePolicy: "required",
        completionRetention: boundedCronCompletionRetention,
        ...(params.requiresProducerClaim !== false ? { requiresProducerClaim: true } : {}),
      },
      params.deliveryIntentId,
      params.tmpDir,
    );
  }
  const delivery = deliverOutboundPayloads({
    cfg: {},
    channel: "matrix",
    to: "!room:example",
    payloads: [
      {
        text: params.deliveryIntentId
          ? "regenerated content must not replace queue custody"
          : "fresh live content",
      },
    ],
    ...(params.deliveryIntentId
      ? {
          queuePolicy: "required" as const,
          deliveryIntentId: params.deliveryIntentId,
          completionRetention: boundedCronCompletionRetention,
          reusePendingDeliveryIntent: true,
        }
      : {
          queuePolicy: "best_effort" as const,
          onDeliveryIntent: ({ id }: { id: string }) => queueIdReady.resolve(id),
        }),
    ...(phase === "provider" ? { onDeliveryResult } : {}),
  });
  const queueId = params.deliveryIntentId ?? (await queueIdReady.promise);
  await entered.promise;
  return {
    delivery,
    messageId,
    queueId,
    release: release.resolve,
    sendText,
    renderPresentation,
    onDeliveryResult,
  };
}

describe("delivery producer lease integration", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("retains fresh delivery ownership before provider I/O after a scheduling stall", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const tmpDir = fixtures.tmpDir();
    let blocked: Awaited<ReturnType<typeof startBlockedDelivery>> | undefined;
    try {
      blocked = await startBlockedDelivery({ tmpDir });
      // Age persisted ownership without running a heartbeat or changing the
      // worker clock before the delayed provider boundary resumes.
      const initial = readQueuedEntry(tmpDir, blocked.queueId);
      setQueuedEntryState(tmpDir, blocked.queueId, {
        retryCount: 0,
        availableAt: (initial.availableAt as number) - 38_000,
      });
      const entry = readQueuedEntry(tmpDir, blocked.queueId);

      expect(entry).toMatchObject({
        recoveryState: "producer_claimed",
        requiresProducerClaim: true,
        producerClaimId: expect.any(String),
        availableAt: expect.any(Number),
      });
      expect(entry.availableAt as number).toBeGreaterThan(Date.now());
      expect(await claimDeliveryPlatformSendAttempt(blocked.queueId, tmpDir)).toBeUndefined();

      blocked.release();
      await expect(blocked.delivery).resolves.toMatchObject([{ messageId: blocked.messageId }]);
      expect(blocked.sendText).toHaveBeenCalledOnce();
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, blocked.queueId, tmpDir),
      ).toBeUndefined();
    } finally {
      blocked?.release();
      await blocked?.delivery.catch(() => undefined);
    }
  });

  it("upgrades and renews a legacy reused intent through long channel preparation", async () => {
    const heartbeat = useLeaseHeartbeatTimers();
    const tmpDir = fixtures.tmpDir();
    const deliveryIntentId = "cron-direct-delivery:v1:renew-long-channel-preparation";
    let blocked: Awaited<ReturnType<typeof startBlockedDelivery>> | undefined;
    try {
      blocked = await startBlockedDelivery({
        tmpDir,
        deliveryIntentId,
        requiresProducerClaim: false,
      });
      const producerClaimId = readQueuedEntry(tmpDir, deliveryIntentId).producerClaimId;
      for (let tick = 0; tick < 3; tick += 1) {
        const availableAt =
          (readQueuedEntry(tmpDir, deliveryIntentId).availableAt as number) - 20_000;
        setQueuedEntryState(tmpDir, deliveryIntentId, { retryCount: 0, availableAt });
        const renewedUntil = await heartbeat();
        expect(renewedUntil).toBeGreaterThan(availableAt);
        expect(readQueuedEntry(tmpDir, deliveryIntentId)).toMatchObject({
          producerClaimId,
          availableAt: renewedUntil,
        });
      }
      setQueuedEntryState(tmpDir, deliveryIntentId, {
        retryCount: 0,
        availableAt: (readQueuedEntry(tmpDir, deliveryIntentId).availableAt as number) - 5_000,
      });

      expect(await claimDeliveryPlatformSendAttempt(deliveryIntentId, tmpDir)).toBeUndefined();
      expect(readQueuedEntry(tmpDir, deliveryIntentId)).toMatchObject({
        recoveryState: "producer_claimed",
        requiresProducerClaim: true,
        availableAt: expect.any(Number),
      });
      expect(readQueuedEntry(tmpDir, deliveryIntentId).availableAt as number).toBeGreaterThan(
        Date.now(),
      );

      blocked.release();
      await expect(blocked.delivery).resolves.toMatchObject([{ messageId: blocked.messageId }]);
      expect(blocked.sendText).toHaveBeenCalledOnce();
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
      ).toBe("completed");
    } finally {
      blocked?.release();
      await blocked?.delivery.catch(() => undefined);
    }
  });

  it("stops before provider I/O when the exact owner is replaced", async () => {
    const heartbeat = useLeaseHeartbeatTimers();
    const tmpDir = fixtures.tmpDir();
    const deliveryIntentId = "cron-direct-delivery:v1:lose-owner-before-provider";
    let blocked: Awaited<ReturnType<typeof startBlockedDelivery>> | undefined;
    try {
      blocked = await startBlockedDelivery({
        tmpDir,
        deliveryIntentId,
        requiresProducerClaim: true,
      });
      expect(readQueuedEntry(tmpDir, deliveryIntentId).producerClaimId).toEqual(expect.any(String));
      setQueuedEntryState(tmpDir, deliveryIntentId, {
        retryCount: 0,
        producerClaimId: "replacement-owner",
      });
      expect(await heartbeat()).toBeUndefined();

      const rejected = expect(blocked.delivery).rejects.toMatchObject({
        message: `Delivery platform claim was lost: ${deliveryIntentId}`,
        queueCustody: "held",
      });
      blocked.release();
      await rejected;

      expect(blocked.sendText).not.toHaveBeenCalled();
      expect(readQueuedEntry(tmpDir, deliveryIntentId)).toMatchObject({
        recoveryState: "producer_claimed",
        producerClaimId: "replacement-owner",
        retryCount: 0,
      });
    } finally {
      blocked?.release();
      await blocked?.delivery.catch(() => undefined);
    }
  });

  it("preserves lease loss through presentation preparation before provider I/O", async () => {
    const heartbeat = useLeaseHeartbeatTimers();
    const tmpDir = fixtures.tmpDir();
    const deliveryIntentId = "cron-direct-delivery:v1:expire-owner-during-presentation";
    let blocked: Awaited<ReturnType<typeof startBlockedDelivery>> | undefined;
    try {
      blocked = await startBlockedDelivery({ tmpDir, deliveryIntentId, phase: "presentation" });
      const producerClaimId = readQueuedEntry(tmpDir, deliveryIntentId).producerClaimId;
      expect(producerClaimId).toEqual(expect.any(String));
      setQueuedEntryState(tmpDir, deliveryIntentId, {
        retryCount: 0,
        availableAt: Date.now() - 1,
      });
      expect(await heartbeat()).toBeUndefined();

      const rejected = expect(blocked.delivery).rejects.toThrow(
        `Delivery platform claim was lost: ${deliveryIntentId}`,
      );
      blocked.release();
      await rejected;

      expect(blocked.renderPresentation).toHaveBeenCalledOnce();
      expect(blocked.sendText).not.toHaveBeenCalled();
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
      ).toBe("pending");
      expect(readQueuedEntry(tmpDir, deliveryIntentId)).toMatchObject({
        recoveryState: "producer_claimed",
        producerClaimId,
        retryCount: 0,
      });
      expect(readQueuedEntry(tmpDir, deliveryIntentId)).not.toHaveProperty("lastError");
      const replacementClaimId = await claimDeliveryPlatformSendAttempt(deliveryIntentId, tmpDir);
      expect(replacementClaimId).toEqual(expect.any(String));
      expect(replacementClaimId).not.toBe(producerClaimId);
    } finally {
      blocked?.release();
      await blocked?.delivery.catch(() => undefined);
    }
  });

  it("does not settle a queue row when the lease expires after provider dispatch", async () => {
    const heartbeat = useLeaseHeartbeatTimers();
    const tmpDir = fixtures.tmpDir();
    const deliveryIntentId = "cron-direct-delivery:v1:expire-owner-after-dispatch";
    const auditEvents: Array<{ outcome: string }> = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    let blocked: Awaited<ReturnType<typeof startBlockedDelivery>> | undefined;
    try {
      blocked = await startBlockedDelivery({ tmpDir, deliveryIntentId, phase: "provider" });
      const dispatched = readQueuedEntry(tmpDir, deliveryIntentId);
      const platformSendAttemptId = dispatched.platformSendAttemptId;
      expect(dispatched).toMatchObject({
        recoveryState: "send_attempt_started",
        platformSendAttemptId: expect.any(String),
        retryCount: 0,
      });
      setQueuedEntryState(tmpDir, deliveryIntentId, {
        retryCount: 0,
        recoveryState: "send_attempt_started",
        platformSendStartedAt: dispatched.platformSendStartedAt as number,
        availableAt: Date.now() - 1,
      });
      expect(await heartbeat()).toBeUndefined();

      const rejected = expect(blocked.delivery).rejects.toThrow(
        `Delivery platform claim was lost: ${deliveryIntentId}`,
      );
      blocked.release();
      await rejected;

      expect(blocked.sendText).toHaveBeenCalledOnce();
      expect(blocked.onDeliveryResult).not.toHaveBeenCalled();
      expect(auditEvents.map((event) => event.outcome)).toEqual(["queued", "platform_started"]);
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
      ).toBe("pending");
      expect(readQueuedEntry(tmpDir, deliveryIntentId)).toMatchObject({
        recoveryState: "send_attempt_started",
        platformSendAttemptId,
        retryCount: 0,
      });
      expect(readQueuedEntry(tmpDir, deliveryIntentId)).not.toHaveProperty("lastError");
    } finally {
      unsubscribe();
      blocked?.release();
      await blocked?.delivery.catch(() => undefined);
    }
  });

  it("settles one exact Matrix send without restart replay", async () => {
    const tmpDir = fixtures.tmpDir();
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const deliveryIntentId = "cron-direct-delivery:v1:exact-completion";
    const messageId = "exact-message";
    const reconcileUnknownSend = vi.fn();
    const sendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
      expect(ctx.deliveryQueueId).toBe(deliveryIntentId);
      await ctx.onPlatformSendDispatch?.();
      return {
        messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "matrix", messageId }],
          kind: "text",
        }),
      };
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
            message: {
              id: "matrix",
              durableFinal: {
                capabilities: { text: true, reconcileUnknownSend: true },
                reconcileUnknownSendKinds: { text: true },
                reconcileUnknownSend,
              },
              send: { text: sendText },
            },
          },
        },
      ]),
    );
    const params = {
      cfg: {},
      channel: "matrix" as const,
      to: "!room:example",
      payloads: [{ text: "send exactly once with durable platform identity" }],
      queuePolicy: "required" as const,
      deliveryIntentId,
      completionRetention: boundedCronCompletionRetention,
      reusePendingDeliveryIntent: true,
      requireUnknownSendReconciliation: true,
    };

    await expect(deliverOutboundPayloads(params)).resolves.toMatchObject([{ messageId }]);
    expect(sendText).toHaveBeenCalledOnce();
    expect(reconcileUnknownSend).not.toHaveBeenCalled();
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("completed");

    const recoveryDeliver = vi.fn<DeliverFn>(async () => []);
    await drainMatrixReconnect({ deliver: recoveryDeliver, stateDir: tmpDir });
    expect(recoveryDeliver).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledOnce();
  });
});
