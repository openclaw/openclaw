import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { onTrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import type {
  ChannelMessageSendAttemptContext,
  ChannelMessageSendTextContext,
} from "../../channels/message/types.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { resolveDeliveryQueueMediaDir } from "../../config/paths.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createInitialDeliveryProducerClaim } from "../delivery-queue-sqlite-claim.kernel.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.test-support.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import { installQueueTestPlugin, matrixDeliveryResult } from "./deliver.custody.test-support.js";
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
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;
const destination = {
  cfg: {},
  channel: "matrix",
  to: "!room:example",
  queuePolicy: "required",
} as const;

function installHeldAdapter(
  reconciliation = false,
  renderPresentation?: ChannelOutboundAdapter["renderPresentation"],
) {
  const prepared = createDeferred();
  const releasePreparation = createDeferred();
  const providerEntered = createDeferred();
  const releaseProvider = createDeferred();
  const releaseResource = vi.fn();
  const resource = { release: releaseResource };
  const beforeSendAttempt = vi.fn(async (ctx: ChannelMessageSendAttemptContext) => {
    prepared.resolve();
    await releasePreparation.promise;
    if (ctx.kind === "media") {
      expect(fs.readFileSync(ctx.mediaUrl, "utf8")).toBe("retained attachment");
    }
    return resource;
  });
  let failProvider = false;
  const send = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
    await ctx.onPlatformSendDispatch?.();
    providerEntered.resolve();
    await releaseProvider.promise;
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
        capabilities: {
          text: true,
          media: true,
          ...(reconciliation ? { reconcileUnknownSend: true } : {}),
        },
        ...(reconciliation
          ? {
              automaticUnknownSendReconciliation: true,
              reconcileUnknownSendKinds: { text: true, media: true },
              reconcileUnknownSend: () => ({ status: "not_sent" as const }),
            }
          : {}),
      },
      send: {
        lifecycle: {
          beforeSendAttempt,
          afterSendFailure,
        },
        text: send,
        media: send,
      },
    },
  });
  return {
    prepared: prepared.promise,
    releasePreparation: releasePreparation.resolve,
    providerEntered: providerEntered.promise,
    releaseProvider: releaseProvider.resolve,
    failProvider: () => {
      failProvider = true;
    },
    send,
    beforeSendAttempt,
    afterSendFailure,
    releaseResource,
  };
}

describe("queued cancellation during adapter preparation", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let stateDir: string;
  const releases: Array<() => void> = [];
  const pending: Promise<unknown>[] = [];
  const subscriptions: Array<() => void> = [];
  function adapterFixture(...args: Parameters<typeof installHeldAdapter>) {
    const adapter = installHeldAdapter(...args);
    releases.push(() => {
      adapter.releasePreparation();
      adapter.releaseProvider();
    });
    return adapter;
  }
  function createCaller() {
    const caller = new AbortController();
    releases.push(() => caller.abort());
    return caller;
  }
  function send(params: Partial<Parameters<typeof deliverOutboundPayloads>[0]> = {}) {
    const delivery = deliverOutboundPayloads({
      ...destination,
      payloads: [{ text: "question" }],
      ...params,
    });
    pending.push(delivery.catch(() => undefined));
    return delivery;
  }
  function audit(terminalOnly = false) {
    const outcomes: string[] = [];
    subscriptions.push(
      onTrustedMessageAuditEvent((event) => {
        if (!terminalOnly || event.action === "message.outbound.finished") {
          outcomes.push(event.outcome);
        }
      }),
    );
    return outcomes;
  }
  const recover = () => drainMatrixReconnect({ stateDir, deliver: deliverOutboundPayloads });
  const pendingDeliveries = () => loadPendingDeliveries(stateDir);
  beforeEach(() => {
    stateDir = fixtures.tmpDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  afterEach(async () => {
    releases
      .splice(0)
      .toReversed()
      .forEach((release) => release());
    await Promise.allSettled(pending.splice(0));
    subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each([
    { reconciliation: false, bestEffort: true },
    { reconciliation: true, bestEffort: false },
  ])(
    "rejects retired queued callers through recovery (reconciliation: $reconciliation, bestEffort: $bestEffort)",
    async ({ reconciliation, bestEffort }) => {
      const adapter = adapterFixture(reconciliation);
      const onPayloadDeliveryOutcome = vi.fn();
      let callerIsActive = true;
      const assertCurrent = () => {
        if (!callerIsActive) {
          throw new Error("message caller retired");
        }
      };
      const delivery = send({
        payloads: [{ text: "caller-bound message" }],
        bestEffort,
        assertDirectAdapterHandoff: assertCurrent,
        onPlatformSendDispatch: async () => assertCurrent(),
        onPayloadDeliveryOutcome,
      });
      const outcome = delivery.then(
        (results) => ({ results }),
        (error: unknown) => ({ error }),
      );

      await adapter.prepared;
      expect(await pendingDeliveries()).toHaveLength(1);
      callerIsActive = false;
      adapter.releasePreparation();
      adapter.releaseProvider();
      const settled = await outcome;
      const rejection = { message: expect.stringContaining("message caller retired") };
      expect(settled).toMatchObject(bestEffort ? { results: [] } : { error: rejection });
      expect(onPayloadDeliveryOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          error: expect.objectContaining(rejection),
        }),
      );
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
      await send({
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
      await send({
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
      const entered = createDeferred();
      const release = createDeferred();
      releases.push(release.resolve);
      const rejectPreparation = vi.fn(async (assertHandoff?: () => void) => {
        entered.resolve();
        await release.promise;
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
      const delivery = send({
        payloads: [
          {
            text: "question",
            ...(stage === "presentation"
              ? { presentation: { blocks: [{ type: "text" as const, text: "question" }] } }
              : {}),
          },
        ],
        assertDirectAdapterHandoff: assertCurrent,
        onDeliveryIntent,
      });
      const outcome = delivery.catch((error: unknown) => error);

      await Promise.race([entered.promise, outcome]);
      expect(rejectPreparation).toHaveBeenCalledOnce();
      expect(await pendingDeliveries()).toHaveLength(1);
      caller.abort(new Error("message caller retired"));
      release.resolve();
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
      const queueIdReady = createDeferred<string>();
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
      const outcome = send({
        abortSignal: controller.signal,
        onDeliveryIntent: ({ id }) => queueIdReady.resolve(id),
        ...(media
          ? {
              deliveryIntentId: stableId,
              reusePendingDeliveryIntent: true,
              completionRetention: boundedCronCompletionRetention,
            }
          : {}),
      }).catch((error: unknown) => error);
      const queueId = await queueIdReady.promise;
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
    const queueIdReady = createDeferred<string>();
    const delivery = send({
      abortSignal: controller.signal,
      onDeliveryIntent: ({ id }) => queueIdReady.resolve(id),
    });
    const outcome = delivery.catch((error: unknown) => error);

    const queueId = await queueIdReady.promise;
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
      const stateDir = fixtures.tmpDir();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
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
      const queueIdReady = createDeferred<string>();
      const delivery = send({
        payloads:
          result === "partial"
            ? [{ text: "accepted part" }, { text: "rejected part" }]
            : [{ text: "question" }],
        bestEffort,
        abortSignal: authority === "signal" ? controller.signal : undefined,
        assertDirectAdapterHandoff: assertCurrent,
        onPlatformSendDispatch: assertCurrent ? async () => assertCurrent() : undefined,
        onDeliveryIntent: ({ id }) => queueIdReady.resolve(id),
      });
      const outcome = delivery.then(
        (results) => ({ results }),
        (error: unknown) => ({ error }),
      );

      const queueId = await queueIdReady.promise;
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
        expect(settled).toMatchObject({ results: [{ messageId: "accepted-message" }] });
        if (result === "sent") {
          expect(await pendingDeliveries()).toEqual([]);
        } else {
          expect(readQueuedEntry(stateDir, queueId).recoveryState).toBe("unknown_after_send");
          vi.useRealTimers();
          await recover();
          expect(adapter.send).toHaveBeenCalledOnce();
        }
      } else {
        expect(settled).toMatchObject(
          bestEffort ? { results: [] } : { error: { queueCustody: "held" } },
        );
        expect(readQueuedEntry(stateDir, queueId).recoveryState).toBe("unknown_after_send");
      }
    },
  );
});
