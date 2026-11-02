import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type {
  ChannelMessageSendAttemptContext,
  ChannelMessageSendTextContext,
} from "../../channels/message/types.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { resolveDeliveryQueueMediaDir } from "../../config/paths.js";
import { createInitialDeliveryProducerClaim } from "../delivery-queue-sqlite-claim.kernel.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.test-support.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import {
  installQueueTestPlugin,
  createDeliveryBarrier,
  useDeliveryCleanup,
  matrixDeliveryResult,
  useOutboundFixture,
} from "./deliver.custody.test-support.js";
import {
  boundedCronCompletionRetention,
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import {
  loadDeliveryQueueMediaRetentionSnapshot,
  OUTBOUND_DELIVERY_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";
import {
  enqueueDelivery,
  enqueueDeliveryOnce,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
} from "./delivery-queue-storage.js";
import {
  loadPendingDeliveries,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

const outbound = useOutboundFixture();
const deliverOutboundPayloads = outbound.deliver;
const destination = {
  cfg: {},
  channel: "matrix",
  to: "!room:example",
  queuePolicy: "required",
} as const;

describe("queued cancellation during adapter preparation", () => {
  let stateDir: string;
  const { release: releases, pending, audit } = useDeliveryCleanup(() => vi.useRealTimers());
  function adapterFixture(
    reconciliation = false,
    renderPresentation?: ChannelOutboundAdapter["renderPresentation"],
  ) {
    const preparation = createDeliveryBarrier();
    const provider = createDeliveryBarrier();
    const releaseResource = vi.fn();
    const resource = { release: releaseResource };
    const beforeSendAttempt = vi.fn(async (ctx: ChannelMessageSendAttemptContext) => {
      await preparation.hold();
      if (ctx.kind === "media") {
        expect(fs.readFileSync(ctx.mediaUrl, "utf8")).toBe("retained attachment");
      }
      return resource;
    });
    let failProvider = false;
    const send = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
      await ctx.onPlatformSendDispatch?.();
      await provider.hold();
      if (failProvider) {
        throw new Error("provider disconnected after dispatch");
      }
      return matrixDeliveryResult("accepted-message");
    });
    const afterSendFailure = vi.fn(({ attemptToken }: { attemptToken?: unknown }) => {
      if (attemptToken === resource) {
        releaseResource();
      }
    });
    installQueueTestPlugin({
      outbound: {
        ...matrixOutboundForQueueTest,
        ...(renderPresentation
          ? { presentationCapabilities: { supported: true }, renderPresentation }
          : {}),
      },
      message: {
        id: "matrix",
        durableFinal: {
          capabilities: { text: true, media: true, reconcileUnknownSend: reconciliation },
          automaticUnknownSendReconciliation: reconciliation,
          reconcileUnknownSendKinds: reconciliation ? { text: true, media: true } : undefined,
          reconcileUnknownSend: reconciliation ? () => ({ status: "not_sent" }) : undefined,
        },
        send: { lifecycle: { beforeSendAttempt, afterSendFailure }, text: send, media: send },
      },
    });
    releases.push(() => {
      preparation.release();
      provider.release();
    });
    return {
      prepared: preparation.entered,
      releasePreparation: preparation.release,
      providerEntered: provider.entered,
      releaseProvider: provider.release,
      failProvider: () => {
        failProvider = true;
      },
      send,
      beforeSendAttempt,
      afterSendFailure,
      releaseResource,
    };
  }
  function createCaller() {
    const caller = new AbortController();
    releases.push(() => caller.abort());
    return caller;
  }
  function dispatch(params: Partial<Parameters<typeof deliverOutboundPayloads>[0]> = {}) {
    const delivery = deliverOutboundPayloads({
      ...destination,
      payloads: [{ text: "question" }],
      ...params,
    });
    pending.push(delivery.catch(() => undefined));
    return delivery;
  }
  function start(params: Partial<Parameters<typeof deliverOutboundPayloads>[0]> = {}) {
    const id = createDeferred<string>();
    const operation = dispatch({
      onDeliveryIntent: ({ id: value }) => id.resolve(value),
      ...params,
    });
    return { queueId: id.promise, outcome: operation.catch((error: unknown) => error) };
  }
  const recover = () => drainMatrixReconnect({ stateDir, deliver: deliverOutboundPayloads });
  const pendingDeliveries = () => loadPendingDeliveries(stateDir);
  beforeEach(() => {
    stateDir = outbound.tmpDir();
  });

  it.each([
    { reconciliation: false, bestEffort: true },
    { reconciliation: true, bestEffort: false },
  ])(
    "rejects retired queued callers through recovery (reconciliation: $reconciliation, bestEffort: $bestEffort)",
    async ({ reconciliation, bestEffort }) => {
      const adapter = adapterFixture(reconciliation);
      const onPayloadDeliveryOutcome = vi.fn();
      const caller = createCaller();
      const assertCurrent = () => caller.signal.throwIfAborted();
      const delivery = dispatch({
        payloads: [{ text: "caller-bound message" }],
        bestEffort,
        assertDirectAdapterHandoff: assertCurrent,
        onPlatformSendDispatch: async () => assertCurrent(),
        onPayloadDeliveryOutcome,
      });
      const outcome = delivery.catch((error: unknown) => error);

      await adapter.prepared;
      expect(await pendingDeliveries()).toHaveLength(1);
      caller.abort(new Error("message caller retired"));
      adapter.releasePreparation();
      adapter.releaseProvider();
      const settled = await outcome;
      const rejection = { message: expect.stringContaining("message caller retired") };
      expect(settled).toMatchObject(bestEffort ? [] : rejection);
      expect(onPayloadDeliveryOutcome.mock.calls[0]?.[0]).toMatchObject({
        status: "failed",
        error: rejection,
      });
      expect(adapter.send).not.toHaveBeenCalled();
      await recover();
      expect(adapter.send).not.toHaveBeenCalled();
      expect(await pendingDeliveries()).toEqual([]);
    },
  );

  it("recovers the valid payload after an active caller's mixed best-effort failures", async () => {
    const adapter = adapterFixture();
    adapter.releasePreparation();
    adapter.releaseProvider();
    const caller = createCaller();
    const delivered: string[] = [];
    const onPayloadDeliveryOutcome = vi.fn();
    let failValidPayload = true;
    adapter.send.mockImplementation(async (ctx) => {
      if (ctx.text === "invalid payload") {
        throw new PlatformMessageNotDispatchedError("invalid payload", {
          cause: undefined,
          retryable: false,
        });
      }
      if (failValidPayload) {
        failValidPayload = false;
        throw new PlatformMessageNotDispatchedError("temporarily unavailable", {
          cause: undefined,
        });
      }
      await ctx.onPlatformSendDispatch?.();
      delivered.push(ctx.text);
      return matrixDeliveryResult("recovered-valid-message");
    });
    expect(
      await dispatch({
        payloads: [{ text: "invalid payload" }, { text: "valid payload" }],
        bestEffort: true,
        assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
        onPayloadDeliveryOutcome,
      }),
    ).toEqual([]);
    expect(onPayloadDeliveryOutcome.mock.calls.map(([outcome]) => outcome)).toMatchObject([
      { index: 0, status: "failed", sentBeforeError: false },
      { index: 1, status: "failed", sentBeforeError: false },
    ]);
    expect(await pendingDeliveries()).toHaveLength(1);
    expect(delivered).toEqual([]);
    await recover();
    expect(delivered).toEqual(["valid payload"]);
    expect(caller.signal.aborted).toBe(false);
  });

  it("retains ambiguous custody when an adapter omits dispatch notification before caller retirement", async () => {
    const adapter = adapterFixture();
    adapter.releasePreparation();
    adapter.releaseProvider();
    const caller = createCaller();
    adapter.send.mockImplementationOnce(async () => {
      caller.abort(new Error("message caller retired"));
      throw new Error("provider response lost after possible delivery");
    });
    const terminals = audit(true);

    expect(
      await dispatch({
        payloads: [{ text: "possibly delivered" }, { text: "must not dispatch" }],
        bestEffort: true,
        assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
      }),
    ).toEqual([]);
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(await pendingDeliveries()).toHaveLength(1);
    expect(terminals).toEqual([]);
    await recover();
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(await pendingDeliveries()).toEqual([]);
    expect(terminals).toEqual(["unknown", "unknown"]);
  });

  it.each(["lifecycle", "presentation", "initial handler"] as const)(
    "retires caller custody when %s preparation rejects after retirement",
    async (stage) => {
      const caller = createCaller();
      const assertCurrent = () => caller.signal.throwIfAborted();
      const gate = createDeliveryBarrier();
      releases.push(gate.release);
      const rejectPreparation = vi.fn(async (assertHandoff?: () => void) => {
        await gate.hold();
        assertHandoff?.();
        throw new Error("asynchronous preparation rejected");
      });
      const renderer = vi
        .fn<NonNullable<ChannelOutboundAdapter["renderPresentation"]>>(({ payload }) => payload)
        .mockImplementationOnce(() => rejectPreparation());
      const adapter = adapterFixture(false, stage === "presentation" ? renderer : undefined);
      let onDeliveryIntent: (() => void) | undefined;
      if (stage === "lifecycle") {
        adapter.beforeSendAttempt.mockImplementationOnce((ctx) =>
          rejectPreparation(ctx.assertDirectAdapterHandoff),
        );
      } else if (stage === "initial handler") {
        const channel = await import("./deliver-channel.js");
        onDeliveryIntent = () => {
          vi.spyOn(channel, "createChannelHandler").mockImplementationOnce(() =>
            rejectPreparation(),
          );
        };
      }
      adapter.releasePreparation();
      adapter.releaseProvider();
      const presentation = { blocks: [{ type: "text" as const, text: "question" }] };
      const delivery = dispatch({
        payloads: [{ text: "question", ...(stage === "presentation" ? { presentation } : {}) }],
        assertDirectAdapterHandoff: assertCurrent,
        onDeliveryIntent,
      });
      const outcome = delivery.catch((error: unknown) => error);

      await Promise.race([gate.entered, outcome]);
      expect(rejectPreparation).toHaveBeenCalledOnce();
      expect(await pendingDeliveries()).toHaveLength(1);
      caller.abort(new Error("message caller retired"));
      gate.release();
      expect(await outcome).toMatchObject({
        message: expect.stringContaining("message caller retired"),
        queueCustody: "released",
      });
      expect(adapter.send).not.toHaveBeenCalled();
      expect(await pendingDeliveries()).toEqual([]);
      await recover();
      expect(adapter.send).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "settles cancelled preparation custody (retained media: %s)",
    async (media) => {
      const adapter = adapterFixture();
      const controller = createCaller();
      const events = audit();
      const stableId = "cron-direct-delivery:v1:cancelled-preparation";
      const artifact = media
        ? path.join(resolveDeliveryQueueMediaDir(stateDir), `${randomUUID()}.txt`)
        : undefined;
      if (artifact) {
        fs.mkdirSync(path.dirname(artifact), { recursive: true });
        fs.writeFileSync(artifact, "retained attachment");
        await enqueueDeliveryOnce(
          {
            channel: "matrix",
            to: destination.to,
            payloads: [{ text: "question", mediaUrl: artifact }],
            completionRetention: boundedCronCompletionRetention,
          },
          stableId,
          stateDir,
        );
      }
      const { outcome, queueId: queueIdPromise } = start({
        abortSignal: controller.signal,
        ...(media
          ? {
              deliveryIntentId: stableId,
              reusePendingDeliveryIntent: true,
              completionRetention: boundedCronCompletionRetention,
            }
          : {}),
      });
      const queueId = await queueIdPromise;
      await adapter.prepared;
      controller.abort(new Error("question ended"));
      expect(await pendingDeliveries()).toHaveLength(1);
      expect(events).toEqual(["queued"]);
      if (artifact) {
        expect(adapter.afterSendFailure).not.toHaveBeenCalled();
        expect(fs.existsSync(artifact)).toBe(true);
      }
      adapter.releasePreparation();
      expect(await outcome).toMatchObject({
        message: expect.stringContaining("Operation aborted"),
        queueCustody: "released",
      });
      expect({
        pending: await pendingDeliveries(),
        sends: adapter.send.mock.calls.length,
        releases: adapter.releaseResource.mock.calls.length,
        events,
      }).toEqual({ pending: [], sends: 0, releases: 1, events: ["queued", "failed"] });
      if (artifact) {
        expect(adapter.afterSendFailure).toHaveBeenCalledOnce();
        const recoveredSend = vi.fn(async () => []);
        await drainMatrixReconnect({ stateDir, deliver: recoveredSend });
        expect(recoveredSend).not.toHaveBeenCalled();
        expect(
          getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, queueId, stateDir),
        ).toBeUndefined();
        expect(fs.existsSync(artifact)).toBe(false);
        expect(
          (await loadDeliveryQueueMediaRetentionSnapshot({ expireBeforeMs: 0, stateDir }))
            .stagedArtifacts,
        ).toEqual([]);
      }
    },
  );

  it("does not retire a replacement producer while old preparation is held", async () => {
    const adapter = adapterFixture();
    const controller = createCaller();
    const { outcome, queueId: queueIdPromise } = start({ abortSignal: controller.signal });

    const queueId = await queueIdPromise;
    await adapter.prepared;
    const replacementClaim = randomUUID();
    setQueuedEntryState(stateDir, queueId, {
      retryCount: 0,
      producerClaimId: replacementClaim,
      availableAt: Date.now() + 60_000,
    });
    controller.abort(new Error("old question ended"));
    expect(readQueuedEntry(stateDir, queueId).producerClaimId).toBe(replacementClaim);
    adapter.releasePreparation();
    expect(await outcome).toMatchObject({ queueCustody: "held" });
    expect(readQueuedEntry(stateDir, queueId).producerClaimId).toBe(replacementClaim);
    expect(adapter.send).not.toHaveBeenCalled();
    expect(adapter.releaseResource).toHaveBeenCalledOnce();
  });

  it.each(["send_attempt_started", "unknown_after_send"] as const)(
    "does not retire the same claim after durable state advances to %s",
    async (state) => {
      const { retireUnsentDelivery } = await import("./delivery-queue-ack.js");
      const initialProducerClaim = createInitialDeliveryProducerClaim();
      const id = await enqueueDelivery({
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "possibly delivered question" }],
        initialProducerClaim,
      });
      const producerClaimId = initialProducerClaim.producerClaimId;
      await markDeliveryPlatformSendAttemptStarted(id, stateDir, undefined, producerClaimId);
      if (state === "unknown_after_send") {
        await markDeliveryPlatformOutcomeUnknown(id, stateDir, producerClaimId);
      }

      expect(await retireUnsentDelivery({ id, producerClaimId, stateDir })).toBeUndefined();
      expect(readQueuedEntry(stateDir, id).recoveryState).toBe(state);
    },
  );

  it.each([
    { result: "sent", authority: "signal", bestEffort: false },
    { result: "ambiguous", authority: "signal", bestEffort: false },
    { result: "ambiguous", authority: "assertion", bestEffort: false },
    { result: "ambiguous", authority: "assertion", bestEffort: true },
    { result: "partial", authority: "assertion", bestEffort: true },
  ] as const)(
    "preserves $result delivery after adapter dispatch has started ($authority, bestEffort: $bestEffort)",
    async ({ result, authority, bestEffort }) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const adapter = adapterFixture();
      const controller = createCaller();
      const assertCurrent =
        authority === "assertion" ? () => controller.signal.throwIfAborted() : undefined;
      const { outcome, queueId: queueIdPromise } = start({
        payloads:
          result === "partial"
            ? [{ text: "accepted part" }, { text: "rejected part" }]
            : [{ text: "question" }],
        bestEffort,
        abortSignal: authority === "signal" ? controller.signal : undefined,
        assertDirectAdapterHandoff: assertCurrent,
        onPlatformSendDispatch: assertCurrent ? async () => assertCurrent() : undefined,
      });
      const queueId = await queueIdPromise;
      await adapter.prepared;
      adapter.releasePreparation();
      await adapter.providerEntered;
      controller.abort(new Error("question ended after dispatch"));
      expect(readQueuedEntry(stateDir, queueId).recoveryState).toBe("send_attempt_started");
      await vi.advanceTimersByTimeAsync(65_000);
      if (result === "ambiguous") {
        adapter.failProvider();
      }
      adapter.releaseProvider();
      const settled = await outcome;
      expect(adapter.send).toHaveBeenCalledOnce();
      if (result === "sent" || result === "partial") {
        expect(settled).toMatchObject([{ messageId: "accepted-message" }]);
        if (result === "sent") {
          expect(await pendingDeliveries()).toEqual([]);
        } else {
          expect(readQueuedEntry(stateDir, queueId).recoveryState).toBe("unknown_after_send");
          vi.useRealTimers();
          await recover();
          expect(adapter.send).toHaveBeenCalledOnce();
        }
      } else {
        expect(settled).toMatchObject(bestEffort ? [] : { queueCustody: "held" });
        expect(readQueuedEntry(stateDir, queueId).recoveryState).toBe("unknown_after_send");
      }
    },
  );
});
