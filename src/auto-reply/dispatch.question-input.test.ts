import { afterEach, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import type { AgentQuestionDispatcher } from "../agents/harness/gateway-question-dispatch.js";
import { registerPendingAgentQuestion } from "../agents/harness/gateway-question.js";
import { isEmbeddedMode, setEmbeddedMode } from "../infra/embedded-mode.js";
import {
  EmbeddedQuestionBroker,
  clearEmbeddedQuestionBroker,
  setEmbeddedQuestionBroker,
} from "../infra/embedded-question-broker.js";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { dispatchInboundMessageWithRoutedChannelDispatcher } from "./dispatch.js";
import { runReplyQuestionInput } from "./reply/agent-runner-question-input.js";
import type { DispatchReplyFromConfig } from "./reply/dispatch-from-config.types.js";
import { createQueueTestRun } from "./reply/queue.test-helpers.js";
import { REPLY_OPERATION_RUN_STATE } from "./reply/reply-operation-run-state.js";
import { withQuestionCreator } from "./reply/reply-run-question.test-support.js";
import { buildTestCtx } from "./reply/test-ctx.js";
import type { ReplyPayload } from "./types.js";

const sessionKey = "agent:main:whatsapp:direct:question-order";
const questionId = "question-order";
const questions = [
  {
    id: "answer",
    header: "Continue",
    question: "Continue?",
    options: [{ label: "Continue" }, { label: "Stop" }],
  },
];

function dispatchResult(queuedFinal: boolean) {
  return { queuedFinal, counts: { tool: 0, block: 0, final: queuedFinal ? 1 : 0 } };
}

async function withQuestion(
  test: (fixture: {
    broker: EmbeddedQuestionBroker;
    operation: Parameters<Parameters<typeof withQuestionCreator>[2]>[0];
    run: ReturnType<typeof createQueueTestRun>;
  }) => Promise<void>,
  uncertain = false,
) {
  const broker = new EmbeddedQuestionBroker(createTestGatewayScheduler());
  const previousEmbeddedMode = isEmbeddedMode();
  setEmbeddedMode(true);
  setEmbeddedQuestionBroker(broker);
  const run = createQueueTestRun(
    { prompt: "Continue" },
    {
      messageProvider: "whatsapp",
      senderId: "+1000",
      agentAccountId: "default",
      chatType: "direct",
    },
  );
  try {
    await withQuestionCreator(sessionKey, run, async (operation) => {
      broker.request({
        id: questionId,
        questions: questions.map(({ id, ...question }) => ({ ...question, questionId: id })),
      });
      const unavailableGateway: AgentQuestionDispatcher = {
        version: 2,
        call: async ({ authority }) => {
          if (authority.kind === "source-bound") {
            authority.assertCurrent();
          }
          throw new GatewayClientRequestError({ code: "UNAVAILABLE", message: "reply lost" });
        },
      };
      const registration = registerPendingAgentQuestion({
        questionId,
        sessionKey,
        questions,
        gatewayCall: uncertain ? unavailableGateway : undefined,
        answer: uncertain
          ? Promise.resolve({ status: "pending" })
          : broker.waitAnswer({ id: questionId }),
      });
      registration.attachRegistration(Promise.resolve());
      try {
        await test({ broker, operation, run });
      } finally {
        registration.dispose();
      }
    });
  } finally {
    broker.stop();
    clearEmbeddedQuestionBroker(broker);
    setEmbeddedMode(previousEmbeddedMode);
  }
}

afterEach(resetGlobalHookRunner);

it.each([
  "correction",
  "cancelled-correction",
  "answered",
  "forbidden",
  "uncertain",
  "terminal",
] as const)(
  "orders %s question input relative to the open question creator and ordinary replies",
  async (outcome) =>
    withQuestion(async ({ broker, operation, run }) => {
      const bypassesFence = ["correction", "cancelled-correction", "answered"].includes(outcome);
      const originalStarted = createDeferred();
      const releaseOriginal = createDeferred();
      const ordinaryStarted = createDeferred();
      const releaseOrdinary = createDeferred();
      const newestStarted = createDeferred();
      const answerClassified = createDeferred();
      const questionSettled = vi.fn();
      const beforeDeliver = vi.fn((payload: ReplyPayload) =>
        outcome === "cancelled-correction" ? null : payload,
      );
      const cancelled = vi.fn();
      const dispatchReplyFromConfig: DispatchReplyFromConfig = async (params) => {
        const messageId = params.ctx.MessageSid;
        if (messageId === "original") {
          originalStarted.resolve();
          await releaseOriginal.promise;
        } else if (messageId === "ordinary") {
          ordinaryStarted.resolve();
          await releaseOrdinary.promise;
        } else if (messageId === "newest") {
          newestStarted.resolve();
        } else {
          const result = await runReplyQuestionInput({
            commandBody:
              outcome === "correction" || outcome === "cancelled-correction" ? "maybe" : "Continue",
            followupRun: bypassesFence
              ? run
              : { ...run, toolsAllow: outcome === "forbidden" ? [] : undefined },
            sessionKey,
            sessionCtx: params.ctx,
            opts: params.replyOptions,
          });
          if (!bypassesFence) {
            if (outcome === "terminal") {
              expect(result).toEqual({ handled: false });
            } else {
              expect(result).toMatchObject({ handled: true, payload: { isError: true } });
            }
            params.dispatcher.sendFinalReply({ text: "answer status", isError: true });
            answerClassified.resolve();
            return dispatchResult(true);
          }
          expect(result.handled).toBe(true);
          const payload = result.handled ? result.payload : undefined;
          if (payload) {
            params.dispatcher.sendFinalReply(payload);
          }
          return dispatchResult(payload !== undefined);
        }
        params.dispatcher.sendFinalReply({
          text: messageId,
          ...(messageId === "newest" ? { isError: true } : {}),
        });
        return dispatchResult(true);
      };
      const deliveries: string[] = [];
      const pending: Promise<unknown>[] = [];
      const dispatch = (messageId: string) => {
        const isAnswer = messageId === "answer";
        const result = dispatchInboundMessageWithRoutedChannelDispatcher({
          ctx: buildTestCtx({
            SessionKey: sessionKey,
            AccountId: "default",
            SenderId: "+1000",
            MessageSid: messageId,
            OriginatingChannel: "whatsapp",
            OriginatingTo: "whatsapp:+1000",
          }),
          cfg: {},
          dispatchReplyFromConfig,
          replyOptions: { [REPLY_OPERATION_RUN_STATE]: {} },
          dispatcherOptions: {
            deliver: async (payload) => {
              deliveries.push(payload.text ?? "");
            },
            beforeDeliver: isAnswer && bypassesFence ? beforeDeliver : undefined,
            onBeforeDeliverCancelled: isAnswer && bypassesFence ? cancelled : undefined,
            onSettled: isAnswer ? questionSettled : undefined,
          },
        });
        pending.push(result);
        return result;
      };
      try {
        const original = dispatch("original");
        await originalStarted.promise;
        const ordinary = bypassesFence ? dispatch("ordinary") : undefined;
        if (ordinary) {
          await ordinaryStarted.promise;
        }
        if (outcome === "terminal") {
          broker.resolve({ id: questionId, cancel: true });
        }
        const answer = dispatch("answer");
        if (bypassesFence) {
          const newest = dispatch("newest");
          await newestStarted.promise;
          const result = await withTestTimeout(
            answer,
            1_000,
            "question input waited for the original foreground reply",
          );
          expect(operation.result).toBeNull();
          expect(questionSettled).toHaveBeenCalledOnce();
          expect(deliveries).toEqual(
            outcome === "correction"
              ? [expect.stringContaining("The answer was not accepted: question 'answer'")]
              : [],
          );
          expect(broker.get({ id: questionId }).question.status).toBe(
            outcome === "answered" ? "answered" : "pending",
          );
          if (outcome === "answered") {
            expect(result.queuedFinal).toBe(false);
            expect(beforeDeliver).not.toHaveBeenCalled();
          } else {
            expect(beforeDeliver).toHaveBeenCalledOnce();
            expect(cancelled).toHaveBeenCalledTimes(outcome === "cancelled-correction" ? 1 : 0);
            expect(result.settledReceipt?.counts.final.cancelled).toBe(
              outcome === "cancelled-correction" ? 1 : 0,
            );
          }
          releaseOriginal.resolve();
          await original;
          expect(deliveries.at(-1)).toBe("original");
          expect(deliveries).not.toContain("newest");
          releaseOrdinary.resolve();
          await Promise.all([ordinary, newest]);
          expect(deliveries.slice(-3)).toEqual(["original", "ordinary", "newest"]);
        } else {
          await withTestTimeout(
            answerClassified.promise,
            1_000,
            "question input was not classified",
          );
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(deliveries).toEqual([]);
          expect(questionSettled).not.toHaveBeenCalled();
          releaseOriginal.resolve();
          await Promise.all([original, answer]);
          expect(deliveries).toEqual(["original", "answer status"]);
          expect(questionSettled).toHaveBeenCalledOnce();
        }
      } finally {
        releaseOriginal.resolve();
        releaseOrdinary.resolve();
        await Promise.allSettled(pending);
      }
    }, outcome === "uncertain"),
);
