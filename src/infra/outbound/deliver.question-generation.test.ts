// Generic outbound delivery binds question finalization before asynchronous send work.
import {
  createQuestionReactionTargetStore,
  questionGatewayRuntime,
} from "openclaw/plugin-sdk/question-gateway-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Question } from "../../../packages/gateway-protocol/src/index.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { QuestionManager } from "../../gateway/question-manager.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type * as ConfirmedVisibleMessage from "../../sessions/background-session-result.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  handleQuestionChannelRequested,
  handleQuestionChannelResolved,
} from "../question-channel-runtime.js";
import {
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "./delivery-queue.test-helpers.js";

// Question finalization must not depend on destination transcript storage.
vi.mock("../../sessions/background-session-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfirmedVisibleMessage>()),
  commitConfirmedVisibleMessage: vi.fn(async () => ({ ok: true })),
}));

let scheduler: ReturnType<typeof createTestGatewayScheduler>;

let runOutboundDeliveryInternal: typeof import("./deliver-queue.js").runOutboundDeliveryInternal;

const questionId = "ask_0123456789abcdef0123456789abcdef";
const questions: Question[] = [
  {
    questionId: "target",
    header: "Target",
    question: "Deploy where?",
    options: [{ label: "Staging" }, { label: "Production" }],
  },
];
const payload = { text: "Deploy where?", channelData: { askUser: { questionId } } };

function request(manager: QuestionManager, timeoutMs: number): void {
  handleQuestionChannelRequested(
    manager.request({
      id: questionId,
      questions,
      timeoutMs,
      onResolved: handleQuestionChannelResolved,
    }),
    scheduler,
  );
}

async function expireAndReuse(manager: QuestionManager, reuseAfterMs = 15_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(50);
  expect(manager.get(questionId)?.status).toBe("expired");
  await vi.advanceTimersByTimeAsync(reuseAfterMs);
  expect(manager.get(questionId)).toBeNull();
  request(manager, 10_000);
}

function installQuestionAdapter(manager: QuestionManager) {
  const finalized = vi.fn<(messageId: string, statusLine: string) => void>();
  const resolveReaction = vi.fn<typeof questionGatewayRuntime.resolveReaction>(async (params) => {
    if (params.optionValue === undefined) {
      throw new Error("Reaction did not carry its rendered option value");
    }
    manager.resolve(
      params.questionId,
      { answers: { target: [params.optionValue] } },
      params.senderId ?? undefined,
    );
    return { status: "answered", questionId: "target", optionValue: params.optionValue };
  });
  const reactions = createQuestionReactionTargetStore({
    channel: "matrix",
    channelDisplayName: "Matrix",
    buildKey: (messageId: string) => messageId,
    resolveReaction,
  });
  const afterDeliverPayload = vi.fn<NonNullable<ChannelOutboundAdapter["afterDeliverPayload"]>>(
    async ({ payload: deliveredPayload, results }) => {
      const id = questionGatewayRuntime.readAskUserQuestionId(deliveredPayload);
      const messageId = results[0]?.messageId;
      if (!id || !messageId) {
        throw new Error("Question delivery did not carry its payload and native message identity");
      }
      questionGatewayRuntime.registerChannelDelivery({
        questionId: id,
        deliveryId: `matrix:${messageId}`,
        finalize: (statusLine) => finalized(messageId, statusLine),
      });
      reactions.register({ questionId: id, optionValues: ["Staging", "Production"] }, messageId);
    },
  );
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "matrix",
          outbound: { ...matrixOutboundForQueueTest, afterDeliverPayload },
        }),
      },
    ]),
  );
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

const destination = { channel: "matrix", to: "!room:example", queuePolicy: "required" } as const;
const unavailable = "Unavailable: request a new question.";

async function assertStaleReaction(
  manager: QuestionManager,
  adapter: ReturnType<typeof installQuestionAdapter>,
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

async function assertFreshReaction(
  manager: QuestionManager,
  adapter: ReturnType<typeof installQuestionAdapter>,
  previousMessageId: string,
  statusLine: string,
) {
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

describe("generic outbound question generation", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();

  beforeAll(async () => {
    ({ runOutboundDeliveryInternal } = await import("./deliver-queue.js"));
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    scheduler = createTestGatewayScheduler("fake-timers");
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it.each([
    {
      delivery: "queued",
      retention: "manager grace",
      reuseAfterMs: 15_000,
      skipQueue: false,
      statusLine: "Expired",
    },
    {
      delivery: "direct",
      retention: "channel retention",
      reuseAfterMs: 24 * 60 * 60 * 1_000,
      skipQueue: true,
      statusLine: unavailable,
    },
  ])(
    "keeps old reactions inert for a held $delivery send after $retention",
    async ({ reuseAfterMs, skipQueue, statusLine }) => {
      const manager = new QuestionManager(scheduler);
      const adapter = installQuestionAdapter(manager);
      const sendEntered = createDeferredCore();
      const releaseSend = createDeferredCore();
      const sendMatrix = vi
        .fn(async () => ({ messageId: "message-b" }))
        .mockImplementationOnce(async () => {
          sendEntered.resolve();
          await releaseSend.promise;
          return { messageId: "message-a" };
        });
      const send = () =>
        runOutboundDeliveryInternal({
          cfg: {},
          ...destination,
          payloads: [payload],
          deps: { matrix: sendMatrix },
          skipQueue,
        });
      let firstSend: ReturnType<typeof send> | undefined;
      try {
        request(manager, 50);
        firstSend = send();
        await sendEntered.promise;
        expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(skipQueue ? 0 : 1);
        await expireAndReuse(manager, reuseAfterMs);
        releaseSend.resolve();
        await expect(firstSend).resolves.toMatchObject([{ messageId: "message-a" }]);

        await assertStaleReaction(manager, adapter, "message-a", statusLine);
        await expect(send()).resolves.toMatchObject([{ messageId: "message-b" }]);
        expect(adapter.finalized).toHaveBeenCalledOnce();
        await assertFreshReaction(manager, adapter, "message-a", statusLine);
        expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(0);
      } finally {
        releaseSend.resolve();
        await Promise.allSettled([firstSend]);
        manager.close();
        await drainGlobalSingletonLifecycleState("restart");
      }
    },
  );

  it.each(["recovered id-only payload", "restored stable-intent custody"])(
    "does not bind %s to a newer question generation, while a fresh send still binds",
    async (custody) => {
      const stableIntent = custody === "restored stable-intent custody";
      const manager = new QuestionManager(scheduler);
      const adapter = installQuestionAdapter(manager);
      const deliveryId = "question-generation-recovery";
      const oldPayload = stableIntent
        ? { ...payload, text: "Original deployment question" }
        : payload;
      const newPayload = stableIntent
        ? { ...payload, text: "Replacement deployment question" }
        : payload;
      const oldMessageId = stableIntent ? "retried-message-a" : "recovered-message-a";
      const sendMatrix = vi
        .fn(async () => ({ messageId: "message-b" }))
        .mockResolvedValueOnce({ messageId: oldMessageId });
      const send = (deliveryIntentId?: string) =>
        runOutboundDeliveryInternal({
          cfg: {},
          ...destination,
          payloads: [newPayload],
          deps: { matrix: sendMatrix },
          ...(stableIntent ? { deliveryIntentId, reusePendingDeliveryIntent: true } : {}),
        });
      try {
        request(manager, 50);
        await expect(
          enqueueDeliveryOnce(
            { ...destination, payloads: [oldPayload] },
            deliveryId,
            fixtures.tmpDir(),
          ),
        ).resolves.toEqual({ id: deliveryId, created: true });
        await expireAndReuse(manager);
        if (stableIntent) {
          await expect(send(deliveryId)).resolves.toMatchObject([{ messageId: oldMessageId }]);
          expect(sendMatrix).toHaveBeenCalledExactlyOnceWith(
            "!room:example",
            oldPayload.text,
            expect.any(Object),
          );
        } else {
          const deliver = vi.fn<DeliverFn>(async (params) =>
            runOutboundDeliveryInternal({ ...params, deps: { matrix: sendMatrix } }),
          );
          await drainMatrixReconnect({ deliver, stateDir: fixtures.tmpDir() });
          expect(deliver).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ deliveryQueueId: deliveryId, skipQueue: true }),
          );
          expect(sendMatrix).toHaveBeenCalledOnce();
        }
        expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(0);
        await assertStaleReaction(manager, adapter, oldMessageId, unavailable, true);
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
        await assertFreshReaction(manager, adapter, oldMessageId, unavailable);
        expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(0);
      } finally {
        manager.close();
        await drainGlobalSingletonLifecycleState("restart");
      }
    },
  );
});
