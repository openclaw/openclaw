import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import type {
  ChannelMessageSendMediaContext,
  ChannelMessageSendTextContext,
} from "../../channels/message/types.js";
import { onOutboundDeliveryEnqueued } from "../delivery-queue-cache.js";
import { loadDeliveryQueueEntries } from "../delivery-queue-sqlite.js";
import { isDeliveryRecoveryOwnedRetry } from "../delivery-recovery.shared.js";
import * as queueAdmission from "./deliver-queue-admission.js";
import {
  installQueueTestPlugin,
  createDeliveryBarrier,
  useDeliveryCleanup,
  matrixDeliveryResult,
  useOutboundFixture,
} from "./deliver.custody.test-support.js";
import { drainMatrixReconnect } from "./deliver.queue-integration.test-support.js";
import { holdEnqueueReply } from "./delivery-queue-enqueue.worker.test-support.js";
import { DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME } from "./delivery-queue-namespaces.js";
import { StableDeliveryPreparationLostError } from "./delivery-queue-preparation.js";
import { drainPendingDeliveriesCore, recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import * as queueStorage from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  loadPendingDeliveries,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";
import { createStructuredOutboundPayloadPlan } from "./payloads.js";
import {
  acceptedPreparedOutboundEntries,
  createUnmodifiedPreparedOutboundBatch,
} from "./prepared-batch.js";

const rollback = useSqliteWorkerFault([
  {
    name: "reject_synthetic_enqueue",
    match: /^insert into delivery_queue_entries /,
    sql: "CREATE TEMP TRIGGER reject_synthetic_enqueue BEFORE INSERT ON delivery_queue_entries WHEN NEW.queue_name = 'outbound-prepared-v1' BEGIN SELECT RAISE(ABORT, 'synthetic enqueue transaction rejected'); END",
  },
]);

const outbound = useOutboundFixture();
const { deliver, structured: deliverStructured } = outbound;

describe("enqueue publication custody through the real sender", () => {
  let stateDir: string;
  const textBody = "synthetic retained text",
    mediaBody = "synthetic retained media";
  const messageId = "synthetic-delivered";
  const { pending, release, unsubscribe, audit } = useDeliveryCleanup();
  function heldReply() {
    const reply = holdEnqueueReply();
    release.push(() => {
      reply.release();
      reply.restore();
    });
    return reply;
  }
  function observe<T>(delivery: Promise<T>) {
    const outcome = delivery.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    pending.push(outcome);
    return outcome;
  }
  beforeEach(() => {
    stateDir = outbound.tmpDir();
  });

  async function source() {
    const mediaUrl = path.join(stateDir, "synthetic.txt");
    await fs.writeFile(mediaUrl, mediaBody);
    return mediaUrl;
  }

  function deliveryParams() {
    return {
      cfg: {},
      channel: "matrix",
      to: "!synthetic:example",
      mediaAccess: { localRoots: [stateDir] },
      queuePolicy: "best_effort",
    } satisfies Omit<Parameters<typeof deliver>[0], "payloads">;
  }

  async function expectReleasedMedia() {
    expect(await loadPendingDeliveries(stateDir)).toEqual([]);
    expect(loadDeliveryQueueEntries(DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME, stateDir)).toEqual([]);
    expect(await fs.readdir(path.join(stateDir, "delivery-queue-media"))).toEqual([]);
  }

  function installSender() {
    const send = vi.fn(
      async (context: ChannelMessageSendMediaContext | ChannelMessageSendTextContext) => {
        await context.onPlatformSendDispatch?.();
        const isMedia = "mediaUrl" in context;
        if (isMedia) {
          expect(await fs.readFile(context.mediaUrl, "utf8")).toBe(mediaBody);
        } else {
          expect(context.text).toBe(textBody);
        }
        return matrixDeliveryResult(messageId, isMedia ? "media" : "text");
      },
    );
    installQueueTestPlugin({
      message: {
        id: "matrix",
        durableFinal: { capabilities: { text: true, media: true } },
        send: { text: send, media: send },
      },
    });
    return send;
  }

  for (const mode of ["startup", "recurring"] as const) {
    it(`keeps ${mode} recovery inspection from preempting a committed live producer`, async ({
      signal,
    }) => {
      const send = installSender();
      const reply = heldReply();
      const reload = createDeliveryBarrier();
      release.push(reload.release);
      const recoverySend = vi.fn(async () => []);
      const delivery = deliver({
        ...deliveryParams(),
        payloads: [{ text: textBody }],
      });
      void observe(delivery);
      await withinTest(
        awaitGateBeforeSettlement(
          reply.held,
          delivery,
          "Delivery settled before committed enqueue reply",
        ),
        signal,
      );
      const [entry] = await withinTest(queueStorage.loadUnfinishedDeliveries(stateDir), signal);
      expect(entry).toMatchObject({
        requiresProducerClaim: true,
        recoveryState: "producer_claimed",
        producerClaimId: expect.any(String),
      });
      expect(entry!.availableAt).toBeGreaterThan(Date.now());

      // Suspend the authoritative read while the producer's writer reply is held.
      const load = queueStorage.loadUnfinishedDelivery;
      vi.spyOn(queueStorage, "loadUnfinishedDelivery").mockImplementation(async (...args) => {
        const current = await load(...args);
        if (args[0] === entry!.id) {
          await reload.hold();
        }
        return current;
      });
      const options = { cfg: {}, stateDir, log: createRecoveryLog(), deliver: recoverySend };
      const recovery =
        mode === "startup"
          ? recoverPendingDeliveries(options)
          : drainPendingDeliveriesCore({
              ...options,
              drainKey: stateDir,
              logLabel: "live producer recovery",
              selectEntry: () => ({ match: true }),
            });
      pending.push(recovery);
      // Recovery may finish without inspecting a row owned by a live producer.
      await withinTest(Promise.race([reload.entered, recovery]), signal);
      reply.release();
      await withinTest(expect(delivery).resolves.toMatchObject([{ messageId }]), signal);
      expect(send).toHaveBeenCalledOnce();
      expect(recoverySend).not.toHaveBeenCalled();
      reload.release();
      await Promise.allSettled([recovery]);
      expect(await queueStorage.loadUnfinishedDeliveries(stateDir)).toEqual([]);
    });
  }

  it("retains prepared media after a committed reply is lost, suppresses live fallback, and recovers exactly once", async () => {
    const mediaUrl = await source();
    const send = installSender();
    const enqueued = vi.fn();
    unsubscribe.push(onOutboundDeliveryEnqueued(enqueued));
    const terminals = audit(true);
    const reply = heldReply();
    const delivery = deliverStructured({
      ...deliveryParams(),
      plan: createStructuredOutboundPayloadPlan([{ mediaUrl }]),
    });
    const outcome = observe(delivery);
    const committed = await awaitGateBeforeSettlement(reply.held, delivery, "Reply was not held");
    expect(committed).toBe("created");
    await reply.lose();
    expect(enqueued).toHaveBeenCalledExactlyOnceWith(stateDir);
    const settled = await outcome;
    expect("error" in settled && isDeliveryRecoveryOwnedRetry(settled.error)).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(terminals).toEqual([]);
    expect(reply.attempts()).toBe(1);
    reply.restore();
    const [entry] = await loadPendingDeliveries(stateDir);
    const artifact = acceptedPreparedOutboundEntries(entry!.preparedBatch)[0]!.payload.mediaUrl!;
    expect(artifact).not.toBe(mediaUrl);
    expect(await fs.readFile(artifact, "utf8")).toBe(mediaBody);
    expect(loadDeliveryQueueEntries(DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME, stateDir)).toEqual([]);
    await fs.unlink(mediaUrl);
    // Simulate lease expiry after the interrupted producer, without waiting for wall time.
    setQueuedEntryState(stateDir, entry!.id, { retryCount: 0, availableAt: 1 });
    await drainMatrixReconnect({ stateDir, deliver });
    await drainMatrixReconnect({ stateDir, deliver });
    expect(send).toHaveBeenCalledOnce();
    expect(await loadPendingDeliveries(stateDir)).toEqual([]);
    await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    expect(terminals).toEqual(["sent"]);
  });

  it("releases media staging after native rollback and permits best-effort live sending", async () => {
    const mediaUrl = await source();
    const enqueued = vi.fn();
    unsubscribe.push(onOutboundDeliveryEnqueued(enqueued));
    rollback.enable();
    const send = installSender();
    const queued = vi.fn();
    const reply = heldReply();
    const admit = queueAdmission.stageAndEnqueueOutboundDelivery;
    let admissionFailure: unknown;
    vi.spyOn(queueAdmission, "stageAndEnqueueOutboundDelivery").mockImplementation(
      async (...args) => {
        try {
          return await admit(...args);
        } catch (error) {
          admissionFailure = error;
          throw error;
        }
      },
    );
    await deliver({
      ...deliveryParams(),
      payloads: [{ mediaUrl }],
      onDeliveryIntent: queued,
    });
    expect(admissionFailure).toMatchObject({
      name: "OutboundDeliveryError",
      stage: "queue",
      queueCustody: "released",
      sentBeforeError: false,
      results: [],
      payloadOutcomes: [],
      cause: {
        name: "PlatformMessageNotDispatchedError",
        code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
        retryable: true,
        cause: { message: "synthetic enqueue transaction rejected" },
      },
    });
    expect(reply.attempts()).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect([queued.mock.calls, enqueued.mock.calls]).toEqual([[], []]);
    await expectReleasedMedia();
    reply.restore();
  });

  it("does not resume a lost preparation when independent cleanup errors wrap it", async () => {
    const mediaUrl = await source();
    const send = installSender();
    const primary = new StableDeliveryPreparationLostError("synthetic-preparation");
    const cleanup = new Error("synthetic media cleanup failure");
    const failure = new AggregateError([primary, cleanup], "admission and cleanup failed", {
      cause: cleanup,
    });
    vi.spyOn(queueAdmission, "stageAndEnqueueOutboundDelivery").mockRejectedValueOnce(failure);
    await expect(
      deliver({
        ...deliveryParams(),
        payloads: [{ mediaUrl }],
      }),
    ).rejects.toBe(failure);
    expect(send).not.toHaveBeenCalled();
  });

  it("releases a staged copy on a known preparation refusal", async () => {
    const mediaUrl = await source();
    const payloads = [{ mediaUrl }];
    await expect(
      queueAdmission.stageAndEnqueueOutboundDelivery(
        {
          ...deliveryParams(),
          payloads,
          deliveryIntentId: "refused-preparation",
          deliveryQueueStateDir: stateDir,
        },
        createUnmodifiedPreparedOutboundBatch(payloads),
        {
          getStablePreparation: async () => {
            throw new Error("preparation owner closed");
          },
        },
      ),
    ).rejects.toThrow("preparation owner closed");
    await expectReleasedMedia();
  });
});
