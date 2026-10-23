import {
  createQuestionReactionTargetStore,
  questionGatewayRuntime as runtime,
} from "openclaw/plugin-sdk/question-gateway-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { QuestionManager } from "../../gateway/question-manager.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
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
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import { loadPendingDeliveries } from "./delivery-queue.test-helpers.js";

let scheduler: ReturnType<typeof createTestGatewayScheduler>;
const outbound = useOutboundFixture();
const deliver = outbound.run;
let manager: QuestionManager;
let adapter: ReturnType<typeof installQuestionAdapter>;

const questionId = "ask_0123456789abcdef0123456789abcdef";
const payload = { text: "Deploy where?", channelData: { askUser: { questionId } } };
const sendMatrix = vi.fn(async () => ({ messageId: "message-b" }));
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
  const afterDeliverPayload = vi.fn<NonNullable<ChannelOutboundAdapter["afterDeliverPayload"]>>(
    async ({ payload: deliveredPayload, results }) => {
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
    },
  );
  installQueueTestPlugin({ outbound: { ...matrixOutboundForQueueTest, afterDeliverPayload } });
  return {
    afterDeliverPayload,
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
  expect(adapter.afterDeliverPayload).toHaveBeenCalledOnce();
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
  expect(adapter.afterDeliverPayload).toHaveBeenCalledTimes(2);
  await expect(adapter.react("message-b", 1)).resolves.toBe(true);
  expect(adapter.resolveReaction).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ questionId, optionValue: "Production" }),
  );
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
  ["queued", "manager grace", 15_000, false, "Expired"],
  ["direct", "channel retention", 24 * 60 * 60 * 1_000, true, unavailable],
] as const)(
  "keeps old reactions inert for a held %s send after %s",
  async (_delivery, _retention, reuseAfterMs, skipQueue, statusLine) => {
    const gate = createDeliveryBarrier();
    sendOptions = { skipQueue };
    sendMatrix.mockImplementationOnce(async () => {
      await gate.hold();
      return { messageId: "message-a" };
    });
    let firstSend: ReturnType<typeof send> | undefined;
    try {
      request(50);
      firstSend = send();
      await gate.entered;
      expect(await loadPendingDeliveries(outbound.tmpDir())).toHaveLength(skipQueue ? 0 : 1);
      await expireAndReuse(reuseAfterMs);
      gate.release();
      await expect(firstSend).resolves.toMatchObject([{ messageId: "message-a" }]);

      await assertStaleReaction("message-a", statusLine);
      await expect(send()).resolves.toMatchObject([{ messageId: "message-b" }]);
      expect(adapter.finalized).toHaveBeenCalledOnce();
      await assertFreshReaction("message-a", statusLine);
      expect(await loadPendingDeliveries(outbound.tmpDir())).toHaveLength(0);
    } finally {
      gate.release();
      await Promise.allSettled([firstSend]);
    }
  },
);

it.each(["recovered id-only payload", "restored stable-intent custody"])(
  "does not bind %s to a newer question generation, while a fresh send still binds",
  async (custody) => {
    const stableIntent = custody === "restored stable-intent custody";
    const deliveryId = "question-generation-recovery";
    const oldPayload = stableIntent
      ? { ...payload, text: "Original deployment question" }
      : payload;
    const newPayload = stableIntent
      ? { ...payload, text: "Replacement deployment question" }
      : payload;
    const oldMessageId = stableIntent ? "retried-message-a" : "recovered-message-a";
    sendMatrix.mockResolvedValueOnce({ messageId: oldMessageId });
    sendOptions = {
      payloads: [newPayload],
      ...(stableIntent ? { reusePendingDeliveryIntent: true } : {}),
    };
    request(50);
    await expect(
      enqueueDeliveryOnce(
        { ...destination, payloads: [oldPayload] },
        deliveryId,
        outbound.tmpDir(),
      ),
    ).resolves.toEqual({ id: deliveryId, created: true });
    await expireAndReuse();
    if (stableIntent) {
      await expect(send(deliveryId)).resolves.toMatchObject([{ messageId: oldMessageId }]);
      expect(sendMatrix).toHaveBeenCalledExactlyOnceWith(
        "!room:example",
        oldPayload.text,
        expect.any(Object),
      );
    } else {
      const recover = vi.fn<DeliverFn>(async (params) =>
        deliver({ ...params, deps: { matrix: sendMatrix } }),
      );
      await drainMatrixReconnect({ deliver: recover, stateDir: outbound.tmpDir() });
      expect(recover).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ deliveryQueueId: deliveryId, skipQueue: true }),
      );
      expect(sendMatrix).toHaveBeenCalledOnce();
    }
    expect(await loadPendingDeliveries(outbound.tmpDir())).toHaveLength(0);
    await assertStaleReaction(oldMessageId, unavailable, true);
    await expect(send("question-generation-fresh-intent")).resolves.toMatchObject([
      { messageId: "message-b" },
    ]);
    if (stableIntent) {
      expect(sendMatrix).toHaveBeenNthCalledWith(
        2,
        "!room:example",
        newPayload.text,
        expect.any(Object),
      );
    }
    await assertFreshReaction(oldMessageId, unavailable);
    expect(await loadPendingDeliveries(outbound.tmpDir())).toHaveLength(0);
  },
);
