import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { onTrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ChannelMessageSendTextContext } from "../../channels/message/types.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.test-support.js";
import {
  installQueueTestPlugin,
  matrixDeliveryResult,
  useOutboundFixture,
} from "./deliver.custody.test-support.js";
import {
  boundedCronCompletionRetention,
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import * as platformLease from "./delivery-queue-platform-lease.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import { claimDeliveryPlatformSendAttempt, enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import { readQueuedEntry, setQueuedEntryState } from "./delivery-queue.test-helpers.js";

const outbound = useOutboundFixture();
const deliverOutboundPayloads = outbound.deliver;

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
  const phase = params.phase ?? "preparation";
  const entered = createDeferred();
  const release = createDeferred();
  const queueIdReady = createDeferred<string>();
  const messageId = "delivered-message";
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
    return matrixDeliveryResult(messageId);
  });
  installQueueTestPlugin({
    outbound: {
      ...matrixOutboundForQueueTest,
      ...(phase === "presentation"
        ? { presentationCapabilities: { supported: true }, renderPresentation }
        : {}),
    },
    message: {
      id: "matrix",
      durableFinal: { capabilities: { text: true } },
      send: {
        ...(phase === "preparation" ? { lifecycle: { beforeSendAttempt: hold } } : {}),
        text: sendText,
      },
    },
  });
  if (params.deliveryIntentId) {
    const payload: ReplyPayload = { text: "queued" };
    if (phase === "presentation") {
      payload.presentation = { blocks: [{ type: "text", text: "rendered" }] };
    }
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [payload],
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
    payloads: [{ text: params.deliveryIntentId ? "regenerated" : "fresh" }],
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
  const fixtures = outbound;
  let tmpDir: string;
  let active: Awaited<ReturnType<typeof startBlockedDelivery>> | undefined;
  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
  });
  async function start(params: Omit<Parameters<typeof startBlockedDelivery>[0], "tmpDir"> = {}) {
    active = await startBlockedDelivery({ tmpDir, ...params });
    return active;
  }
  const read = (id: string) => readQueuedEntry(tmpDir, id);
  const queuedStatus = (id: string) =>
    getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir);

  afterEach(async () => {
    active?.release();
    await active?.delivery.catch(() => undefined);
    active = undefined;
    vi.useRealTimers();
  });

  it("retains fresh delivery ownership before provider I/O after a scheduling stall", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const blocked = await start();
    // Age persisted ownership without running a heartbeat or changing the
    // worker clock before the delayed provider boundary resumes.
    const initial = read(blocked.queueId);
    setQueuedEntryState(tmpDir, blocked.queueId, {
      retryCount: 0,
      availableAt: (initial.availableAt as number) - 38_000,
    });
    const entry = read(blocked.queueId);

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
    expect(queuedStatus(blocked.queueId)).toBeUndefined();
  });

  it("upgrades and renews a legacy reused intent through long channel preparation", async () => {
    const heartbeat = useLeaseHeartbeatTimers();
    const deliveryIntentId = "cron-direct-delivery:v1:renew-long-channel-preparation";
    const blocked = await start({
      deliveryIntentId,
      requiresProducerClaim: false,
    });
    const producerClaimId = read(deliveryIntentId).producerClaimId;
    for (let tick = 0; tick < 3; tick += 1) {
      const availableAt = (read(deliveryIntentId).availableAt as number) - 20_000;
      setQueuedEntryState(tmpDir, deliveryIntentId, { retryCount: 0, availableAt });
      const renewedUntil = await heartbeat();
      expect(renewedUntil).toBeGreaterThan(availableAt);
      expect(read(deliveryIntentId)).toMatchObject({
        producerClaimId,
        availableAt: renewedUntil,
      });
    }
    setQueuedEntryState(tmpDir, deliveryIntentId, {
      retryCount: 0,
      availableAt: (read(deliveryIntentId).availableAt as number) - 5_000,
    });

    expect(await claimDeliveryPlatformSendAttempt(deliveryIntentId, tmpDir)).toBeUndefined();
    expect(read(deliveryIntentId)).toMatchObject({
      recoveryState: "producer_claimed",
      requiresProducerClaim: true,
      availableAt: expect.any(Number),
    });
    expect(read(deliveryIntentId).availableAt as number).toBeGreaterThan(Date.now());

    blocked.release();
    await expect(blocked.delivery).resolves.toMatchObject([{ messageId: blocked.messageId }]);
    expect(blocked.sendText).toHaveBeenCalledOnce();
    expect(queuedStatus(deliveryIntentId)).toBe("completed");
  });

  it.each(["preparation", "presentation", "provider"] as const)(
    "preserves lost ownership during %s",
    async (phase) => {
      const heartbeat = useLeaseHeartbeatTimers();
      const deliveryIntentId = `cron-direct-delivery:v1:lose-owner-${phase}`;
      const auditEvents: Array<{ outcome: string }> = [];
      const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
      try {
        const blocked = await start({ deliveryIntentId, phase });
        const initial = read(deliveryIntentId);
        const afterDispatch = phase === "provider";
        if (afterDispatch) {
          expect(initial).toMatchObject({
            recoveryState: "send_attempt_started",
            platformSendAttemptId: expect.any(String),
            retryCount: 0,
          });
        } else {
          expect(initial.producerClaimId).toEqual(expect.any(String));
        }
        setQueuedEntryState(tmpDir, deliveryIntentId, {
          retryCount: 0,
          ...(phase === "preparation"
            ? { producerClaimId: "replacement-owner" }
            : {
                availableAt: Date.now() - 1,
                ...(afterDispatch
                  ? {
                      recoveryState: "send_attempt_started",
                      platformSendStartedAt: initial.platformSendStartedAt as number,
                    }
                  : {}),
              }),
        });
        expect(await heartbeat()).toBeUndefined();
        const message = `Delivery platform claim was lost: ${deliveryIntentId}`;
        const rejected =
          phase === "preparation"
            ? expect(blocked.delivery).rejects.toMatchObject({ message, queueCustody: "held" })
            : expect(blocked.delivery).rejects.toThrow(message);
        blocked.release();
        await rejected;
        expect(blocked.sendText).toHaveBeenCalledTimes(afterDispatch ? 1 : 0);
        expect(read(deliveryIntentId)).toMatchObject({
          retryCount: 0,
          recoveryState: afterDispatch ? "send_attempt_started" : "producer_claimed",
          ...(afterDispatch
            ? { platformSendAttemptId: initial.platformSendAttemptId }
            : {
                producerClaimId:
                  phase === "preparation" ? "replacement-owner" : initial.producerClaimId,
              }),
        });
        if (phase !== "preparation") {
          expect(queuedStatus(deliveryIntentId)).toBe("pending");
          expect(read(deliveryIntentId)).not.toHaveProperty("lastError");
        }
        if (afterDispatch) {
          expect(blocked.onDeliveryResult).not.toHaveBeenCalled();
          expect(auditEvents.map((event) => event.outcome)).toEqual(["queued", "platform_started"]);
        } else if (phase === "presentation") {
          expect(blocked.renderPresentation).toHaveBeenCalledOnce();
          const replacement = await claimDeliveryPlatformSendAttempt(deliveryIntentId, tmpDir);
          expect(replacement).toEqual(expect.any(String));
          expect(replacement).not.toBe(initial.producerClaimId);
        }
      } finally {
        unsubscribe();
      }
    },
  );

  it("settles one exact Matrix send without restart replay", async () => {
    const deliveryIntentId = "cron-direct-delivery:v1:exact-completion";
    const messageId = "exact-message";
    const reconcileUnknownSend = vi.fn();
    const sendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
      expect(ctx.deliveryQueueId).toBe(deliveryIntentId);
      await ctx.onPlatformSendDispatch?.();
      return matrixDeliveryResult(messageId);
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
    expect(queuedStatus(deliveryIntentId)).toBe("completed");

    const recoveryDeliver = vi.fn<DeliverFn>(async () => []);
    await drainMatrixReconnect({ deliver: recoveryDeliver, stateDir: tmpDir });
    expect(recoveryDeliver).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledOnce();
  });
});
