import fs from "node:fs/promises";
import path from "node:path";
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import {
  createQuestionReactionTargetStore,
  questionGatewayRuntime as runtime,
} from "openclaw/plugin-sdk/question-gateway-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { QuestionManager } from "../../gateway/question-manager.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.test-support.js";
import {
  handleQuestionChannelRequested,
  handleQuestionChannelResolved,
} from "../question-channel-runtime.js";
import {
  createDeliveryBarrier,
  installQueueTestPlugin,
  useOutboundFixture,
} from "./deliver.custody.test-support.js";
import {
  boundedCronCompletionRetention,
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import {
  awaitCustodyReply,
  installCustodyMatrixPlugin,
} from "./delivery-queue-custody.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-namespaces.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import * as queueStorage from "./delivery-queue-storage.js";
import {
  holdAcknowledgementReply,
  holdDeliveryQueueReply,
} from "./delivery-queue-worker-reply.test-support.js";
import {
  loadPendingDeliveries,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

const outbound = useOutboundFixture();
describe("outbound question generations", () => {
  let scheduler: ReturnType<typeof createTestGatewayScheduler>;
  const deliver = outbound.run;
  let manager: QuestionManager;
  let adapter: ReturnType<typeof installQuestionAdapter>;

  const questionId = "ask_0123456789abcdef0123456789abcdef";
  const payload = { text: "Deploy where?", channelData: { askUser: { questionId } } };
  const sendMatrix = vi.fn(async (_to: string, _text: string) => ({ messageId: "message-b" }));
  let sendOptions: Partial<Parameters<typeof deliver>[0]>;

  function request(timeoutMs: number): void {
    handleQuestionChannelRequested(
      manager.request({
        id: questionId,
        questions: [
          {
            questionId: "target",
            header: "Target",
            question: "Deploy where?",
            options: [{ label: "Staging" }, { label: "Production" }],
          },
        ],
        timeoutMs,
        onResolved: handleQuestionChannelResolved,
      }),
      scheduler,
    );
  }

  async function expireAndReuse(reuseAfterMs = 15_000): Promise<void> {
    await vi.advanceTimersByTimeAsync(50);
    expect(manager.get(questionId)?.status).toBe("expired");
    await vi.advanceTimersByTimeAsync(reuseAfterMs);
    expect(manager.get(questionId)).toBeNull();
    request(10_000);
  }

  function installQuestionAdapter() {
    const finalized = vi.fn<(messageId: string, statusLine: string) => void>();
    const resolveReaction = vi.fn<typeof runtime.resolveReaction>(
      async ({ optionValue, questionId: id, senderId }) => {
        if (optionValue === undefined) {
          throw new Error("Reaction did not carry its rendered option value");
        }
        manager.resolve(id, { answers: { target: [optionValue] } }, senderId ?? undefined);
        return { status: "answered", questionId: "target", optionValue };
      },
    );
    const reactions = createQuestionReactionTargetStore({
      channel: "matrix",
      channelDisplayName: "Matrix",
      buildKey: (messageId: string) => messageId,
      resolveReaction,
    });
    const afterDeliverPayload: NonNullable<ChannelOutboundAdapter["afterDeliverPayload"]> = async ({
      payload: deliveredPayload,
      results,
    }) => {
      const id = runtime.readAskUserQuestionId(deliveredPayload);
      const messageId = results[0]?.messageId;
      if (!id || !messageId) {
        throw new Error("Question delivery did not carry its payload and native message identity");
      }
      runtime.registerChannelDelivery({
        questionId: id,
        deliveryId: `matrix:${messageId}`,
        finalize: (statusLine) => finalized(messageId, statusLine),
      });
      reactions.register({ questionId: id, optionValues: ["Staging", "Production"] }, messageId);
    };
    installQueueTestPlugin({ outbound: { ...matrixOutboundForQueueTest, afterDeliverPayload } });
    return {
      finalized,
      resolveReaction,
      react: (messageId: string, optionIndex: number) =>
        reactions.resolve({
          identities: [messageId],
          optionIndex,
          cfg: {},
          senderId: "operator",
        }),
    };
  }

  const destination = {
    cfg: {},
    channel: "matrix",
    to: "!room:example",
    queuePolicy: "required",
  } as const;
  const unavailable = "Unavailable: request a new question.";
  const send = (deliveryIntentId?: string) =>
    deliver({
      ...destination,
      payloads: [payload],
      deps: { matrix: sendMatrix },
      ...sendOptions,
      ...(sendOptions.reusePendingDeliveryIntent ? { deliveryIntentId } : {}),
    });

  async function assertStaleReaction(
    messageId: string,
    statusLine: string,
    finalizedBeforeReaction = false,
  ) {
    if (finalizedBeforeReaction) {
      expect(adapter.finalized).toHaveBeenCalledExactlyOnceWith(messageId, statusLine);
    }
    expect(manager.get(questionId)?.status).toBe("pending");
    await expect(adapter.react(messageId, 1)).resolves.toBe(true);
    expect(adapter.resolveReaction).not.toHaveBeenCalled();
    expect(manager.get(questionId)?.status).toBe("pending");
    expect(adapter.finalized).toHaveBeenCalledExactlyOnceWith(messageId, statusLine);
  }

  async function assertFreshReaction(previousMessageId: string, statusLine: string) {
    await expect(adapter.react("message-b", 1)).resolves.toBe(true);
    expect(manager.get(questionId)).toMatchObject({
      status: "answered",
      answers: { answers: { target: ["Production"] } },
    });
    expect(adapter.finalized.mock.calls).toEqual([
      [previousMessageId, statusLine],
      ["message-b", "Answered: Production"],
    ]);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    scheduler = createTestGatewayScheduler("fake-timers");
    manager = new QuestionManager(scheduler);
    adapter = installQuestionAdapter();
    sendMatrix.mockReset().mockResolvedValue({ messageId: "message-b" });
    sendOptions = {};
  });

  afterEach(async () => {
    manager.close();
    await drainGlobalSingletonLifecycleState("restart");
    vi.useRealTimers();
  });

  it.each([
    ["held queued send", "held", 15_000, false, "Expired"],
    ["held direct send", "held", 24 * 60 * 60 * 1_000, true, unavailable],
    ["recovered id-only payload", "recovery", 15_000, false, unavailable],
    ["restored stable-intent custody", "stable", 15_000, false, unavailable],
  ] as const)(
    "keeps %s on its original question generation",
    async (_name, mode, reuseAfterMs, skipQueue, statusLine) => {
      const stableIntent = mode === "stable";
      const oldPayload = stableIntent
        ? { ...payload, text: "Original deployment question" }
        : payload;
      const newPayload = stableIntent
        ? { ...payload, text: "Replacement deployment question" }
        : payload;
      const deliveryId = "recovery";
      const gate = createDeliveryBarrier();
      sendOptions = { skipQueue, payloads: [newPayload], reusePendingDeliveryIntent: stableIntent };
      sendMatrix.mockImplementationOnce(async () => {
        if (mode === "held") {
          await gate.hold();
        }
        return { messageId: "message-a" };
      });
      let firstSend: ReturnType<typeof send> | undefined;
      try {
        request(50);
        if (mode === "held") {
          firstSend = send();
          await gate.entered;
          expect(await loadPendingDeliveries(outbound.tmpDir())).toHaveLength(skipQueue ? 0 : 1);
        } else {
          await expect(
            queueStorage.enqueueDeliveryOnce(
              { ...destination, payloads: [oldPayload] },
              deliveryId,
              outbound.tmpDir(),
            ),
          ).resolves.toEqual({ id: deliveryId, created: true });
        }
        await expireAndReuse(reuseAfterMs);
        if (mode === "held") {
          gate.release();
          await expect(firstSend).resolves.toMatchObject([{ messageId: "message-a" }]);
        } else if (stableIntent) {
          await expect(send(deliveryId)).resolves.toMatchObject([{ messageId: "message-a" }]);
        } else {
          const recover: DeliverFn = (params) =>
            deliver({ ...params, deps: { matrix: sendMatrix } });
          await drainMatrixReconnect({ deliver: recover, stateDir: outbound.tmpDir() });
        }
        expect(await loadPendingDeliveries(outbound.tmpDir())).toHaveLength(0);
        await assertStaleReaction("message-a", statusLine, mode !== "held");
        await expect(send("fresh")).resolves.toMatchObject([{ messageId: "message-b" }]);
        expect(sendMatrix.mock.calls.map(([, text]) => text)).toEqual([
          oldPayload.text,
          newPayload.text,
        ]);
        await assertFreshReaction("message-a", statusLine);
        expect(await loadPendingDeliveries(outbound.tmpDir())).toHaveLength(0);
      } finally {
        gate.release();
        await Promise.allSettled([firstSend]);
      }
    },
  );
});

describe("outbound custody reply loss", () => {
  const fixtures = outbound;
  const deliverOutboundPayloads = outbound.deliver;

  async function createArtifact(stateDir: string, extension: "txt" | "ogg") {
    const artifact = path.join(
      stateDir,
      "delivery-queue-media",
      `00000000-0000-4000-8000-000000000001.${extension}`,
    );
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, "synthetic queued audio");
    return artifact;
  }

  const expectMedia = (artifact: string) =>
    expect(fs.readFile(artifact, "utf8")).resolves.toBe("synthetic queued audio");

  async function loseReply<T>(
    reply: ReturnType<typeof holdDeliveryQueueReply<T>>,
    outcome: Promise<unknown>,
    inspect: (value: T) => Promise<void> = async () => {},
  ) {
    try {
      const value = await awaitCustodyReply(reply.held, outcome);
      await inspect(value);
      await reply.lose();
      const failure = await outcome;
      expect(failure).toBeInstanceOf(Error);
      expect(collectNestedErrorCandidates(failure).map(extractErrorCode)).toContain(
        "outcome-unknown",
      );
      expect(reply.attempts()).toBe(1);
      return value;
    } finally {
      reply.restore();
      reply.release();
      await outcome;
    }
  }

  it.each(["pre-send fallback", "post-send settlement"] as const)(
    "does not replay a committed %s or release unacknowledged media",
    async (phase) => {
      const stateDir = fixtures.tmpDir();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const artifact = await createArtifact(stateDir, "txt");
      installCustodyMatrixPlugin(matrixOutboundForQueueTest);
      if (phase === "pre-send fallback") {
        vi.spyOn(queueStorage, "markDeliveryPlatformSendAttemptStarted").mockRejectedValueOnce(
          new Error("synthetic marker failure"),
        );
      }
      const send = vi.fn(async () => ({ messageId: "synthetic-sent" }));
      const queued = createDeferredCore<{
        id: string;
        reply: ReturnType<typeof holdAcknowledgementReply>;
      }>();
      const outcome = deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!synthetic:example",
        payloads: [{ text: "synthetic delivery", mediaUrl: artifact }],
        queuePolicy: phase === "pre-send fallback" ? "best_effort" : "required",
        requireUnknownSendReconciliation: false,
        deps: { matrix: send },
        onDeliveryIntent: ({ id }) => queued.resolve({ id, reply: holdAcknowledgementReply(id) }),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      const { id, reply } = await awaitCustodyReply(queued.promise, outcome);
      const committedPaths = await loseReply(reply, outcome, async (paths) => {
        expect(paths).toHaveLength(1);
        const committedArtifact = paths[0]!;
        expect(path.dirname(committedArtifact)).toBe(path.join(stateDir, "delivery-queue-media"));
        expect(send).toHaveBeenCalledTimes(phase === "pre-send fallback" ? 0 : 1);
        await expectMedia(committedArtifact);
      });
      const committedArtifact = committedPaths[0]!;
      expect(send).toHaveBeenCalledTimes(phase === "pre-send fallback" ? 0 : 1);
      await closeOpenClawStateDatabaseAsync();
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir),
      ).toBeUndefined();
      await expectMedia(committedArtifact);
      await drainMatrixReconnect({ stateDir, deliver: deliverOutboundPayloads });
      expect(send).toHaveBeenCalledTimes(phase === "pre-send fallback" ? 0 : 1);
    },
  );

  it("retains committed claim custody and media until a later explicit recovery", async () => {
    const stateDir = fixtures.tmpDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const id = "cron-direct-delivery:v1:claim-reply-loss";
    const artifact = await createArtifact(stateDir, "ogg");
    installCustodyMatrixPlugin(matrixOutboundForQueueTest);
    await queueStorage.enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!synthetic:example",
        payloads: [{ text: "recover once", mediaUrl: artifact }],
        queuePolicy: "required",
        requiresProducerClaim: true,
        completionRetention: boundedCronCompletionRetention,
        maxRetries: 2,
      },
      id,
      stateDir,
    );
    const before = readQueuedEntry(stateDir, id);
    const sendMatrix = vi.fn(async () => {
      await expectMedia(artifact);
      return { messageId: "recovered-after-claim-expiry" };
    });
    const deliver: DeliverFn = (params) =>
      deliverOutboundPayloads({ ...params, deps: { matrix: sendMatrix } });
    const recover = () => drainMatrixReconnect({ deliver, stateDir });
    const reply = holdDeliveryQueueReply("deliveryQueue.claimPlatformSend", id, (value) =>
      typeof value === "string" ? value : undefined,
    );
    const outcome = recover().then(
      () => undefined,
      (error: unknown) => error,
    );
    const committedClaim = await loseReply(reply, outcome);
    expect(committedClaim).toEqual(expect.any(String));
    expect(sendMatrix).not.toHaveBeenCalled();
    await closeOpenClawStateDatabaseAsync();
    const retained = readQueuedEntry(stateDir, id);
    expect(retained).toEqual({
      ...before,
      recoveryState: "producer_claimed",
      producerClaimId: committedClaim,
      availableAt: expect.any(Number),
    });
    expect(retained.availableAt as number).toBeGreaterThan(Date.now());
    await expectMedia(artifact);
    await recover();
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(readQueuedEntry(stateDir, id)).toEqual(retained);
    await expectMedia(artifact);
    setQueuedEntryState(stateDir, id, { retryCount: 0, availableAt: Date.now() - 1 });
    await recover();
    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir)).toBe(
      "completed",
    );
    await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    await recover();
    expect(sendMatrix).toHaveBeenCalledOnce();
  });
});
