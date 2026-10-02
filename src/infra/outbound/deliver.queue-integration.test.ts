import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import {
  isOutboundDeliveryError,
  PlatformMessageNotDispatchedError,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
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
  reserveDeliveryAttempt,
  enqueueDeliveryOnce,
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

function createPartialSendFailure() {
  return vi
    .fn()
    .mockResolvedValueOnce({ messageId: "m1" })
    .mockRejectedValueOnce(new Error("second payload send failed"));
}

async function deliverPartialMatrixBatch(sendMatrix: ReturnType<typeof vi.fn>, tmpDir: string) {
  process.env.OPENCLAW_STATE_DIR = tmpDir;
  await expect(
    deliverMatrix({
      payloads: [{ text: "first" }, { text: "second" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required",
    }),
  ).rejects.toThrow("second payload send failed");
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

  it("never acknowledges or replays a partially sent best-effort stable intent", async () => {
    const sendMatrix = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "best-effort-first-message" })
      .mockRejectedValueOnce(new Error("best-effort second payload failed"));
    const onError = vi.fn();
    const deliveryIntentId = "cron-direct-delivery:v1:best-effort-partial-send";
    const params = matrixRequest({
      payloads: [{ text: "sent first" }, { text: "failed second" }],
      deps: { matrix: sendMatrix },
      bestEffort: true,
      queuePolicy: "best_effort" as const,
      deliveryIntentId,
      completionRetention: boundedCronCompletionRetention,
      reusePendingDeliveryIntent: true,
      onError,
    });

    await expect(deliverOutboundPayloads(params)).resolves.toMatchObject([
      { messageId: "best-effort-first-message" },
    ]);
    expect(onError).toHaveBeenCalledOnce();
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
    expect(sendMatrix).toHaveBeenCalledTimes(2);
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

  it.each(["abort", "permanent rejection"] as const)(
    "preserves an already-sent Matrix payload when a later payload ends in %s",
    async (failureKind) => {
      const cause =
        failureKind === "abort"
          ? Object.assign(new Error("later stable delivery aborted"), { name: "AbortError" })
          : new PlatformMessageNotDispatchedError("later stable payload permanently rejected", {
              cause: new Error("invalid second payload"),
              retryable: false,
            });
      const sendMatrix = vi
        .fn()
        .mockResolvedValueOnce({ messageId: "already-visible-stable-message" })
        .mockRejectedValueOnce(cause);
      const deliveryIntentId = `cron-direct-delivery:v1:partial-${failureKind.replaceAll(" ", "-")}-no-replay`;
      const params = {
        cfg: {} as OpenClawConfig,
        channel: "matrix" as const,
        to: "!room:example",
        payloads: [{ text: "already visible" }, { text: "later terminal failure" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required" as const,
        deliveryIntentId,
        completionRetention: boundedCronCompletionRetention,
        reusePendingDeliveryIntent: true,
      };

      await expect(deliverOutboundPayloads(params)).rejects.toThrow(cause.message);
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
    },
  );

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

  it("drain reports every payload unknown when an interrupted mixed batch cannot be reconciled", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const sendMatrix = createPartialSendFailure();

    await deliverPartialMatrixBatch(sendMatrix, tmpDir);
    expect(auditEvents).toHaveLength(4);

    const beforeDrain = await loadPendingDeliveries(tmpDir);
    expect(beforeDrain[0]?.recoveryState).toBe("unknown_after_send");
    const deliver = vi.fn<DeliverFn>(async () => {});
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });
    unsubscribe();

    expect(deliver).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
    expect(auditEvents).toHaveLength(6);
    expect(auditEvents.slice(-2).map((event) => event.sourceId)).toEqual([
      `message:outbound:queue:${beforeDrain[0]?.id}:payload:0`,
      `message:outbound:queue:${beforeDrain[0]?.id}:payload:1`,
    ]);
    expect(auditEvents.slice(-2).map((event) => event.outcome)).toEqual(["unknown", "unknown"]);
    expect(auditEvents.slice(-2).map((event) => event.resultCount)).toEqual([0, 0]);
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

  it.each([
    [
      "a reusable producer intent",
      {
        deliveryIntentId: "cron-direct-delivery:v1:reusable-proven-not-sent",
        completionRetention: boundedCronCompletionRetention,
        reusePendingDeliveryIntent: true,
      },
    ],
    ["a caller that only reports the failure", {}],
  ])(
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
  const attemptSend = async (params: {
    sendMatrix: ReturnType<typeof vi.fn>;
    onPlatformSendDispatch?: () => Promise<void>;
    onPayloadDeliveryOutcome: (outcome: OutboundPayloadDeliveryOutcome) => void;
  }) =>
    deliverMatrix({
      payloads: [{ text: "first" }],
      deps: { matrix: params.sendMatrix },
      queuePolicy: "required",
      onPlatformSendDispatch: params.onPlatformSendDispatch,
      onPayloadDeliveryOutcome: params.onPayloadDeliveryOutcome,
    }).catch((caught: unknown) => caught);

  it("retains retryable custody when an adapter fails before dispatch", async () => {
    const sendMatrix = vi.fn();
    const onPayloadDeliveryOutcome = vi.fn();
    const failure = await attemptSend({
      sendMatrix,
      onPlatformSendDispatch: async () => {
        throw new Error("dispatch preparation failed");
      },
      onPayloadDeliveryOutcome,
    });

    expect(failure).toMatchObject({ message: "dispatch preparation failed" });
    expect(isOutboundDeliveryError(failure) && failure.queueCustody).toBe("held");
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      retryCount: 1,
      recoveryState: "send_attempt_started",
    });
    expect(onPayloadDeliveryOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", sentBeforeError: false }),
    );
    expect(sendMatrix).not.toHaveBeenCalled();
  });

  it("reports an ambiguous payload when an adapter fails after dispatch", async () => {
    const sendMatrix = vi.fn().mockRejectedValueOnce(new Error("first payload send failed"));
    const onPayloadDeliveryOutcome = vi.fn();
    const failure = await attemptSend({ sendMatrix, onPayloadDeliveryOutcome });

    expect(failure).toMatchObject({ message: "first payload send failed", sentBeforeError: true });
    expect(isOutboundDeliveryError(failure) && failure.queueCustody).toBe("held");
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      retryCount: 1,
      recoveryState: "unknown_after_send",
    });
    expect(onPayloadDeliveryOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        sentBeforeError: true,
        error: expect.objectContaining({ queueCustody: "held" }),
      }),
    );
  });

  it("preserves dispatch evidence for an all-failed best-effort batch", async () => {
    const sendMatrix = vi.fn().mockRejectedValueOnce(new Error("provider result was lost"));
    const onPayloadDeliveryOutcome = vi.fn();

    await expect(
      deliverMatrix({
        payloads: [{ text: "first" }],
        deps: { matrix: sendMatrix },
        bestEffort: true,
        queuePolicy: "best_effort",
        onPayloadDeliveryOutcome,
      }),
    ).resolves.toEqual([]);

    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      retryCount: 1,
      recoveryState: "unknown_after_send",
    });
    expect(onPayloadDeliveryOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        sentBeforeError: true,
        error: expect.objectContaining({ queueCustody: "held" }),
      }),
    );
  });
});
