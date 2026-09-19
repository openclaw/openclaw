import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import type { AgentQuestionDispatcher } from "../agents/harness/gateway-question-dispatch.js";
import { registerPendingAgentQuestion } from "../agents/harness/gateway-question.js";
import { withPreparedEmbeddedRunToolAuthority } from "../agents/harness/tool-authority.runtime.js";
import { isEmbeddedMode, setEmbeddedMode } from "../infra/embedded-mode.js";
import {
  EmbeddedQuestionBroker,
  clearEmbeddedQuestionBroker,
  setEmbeddedQuestionBroker,
} from "../infra/embedded-question-broker.js";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { dispatchInboundMessageWithRoutedChannelDispatcher } from "./dispatch.js";
import { runReplyQuestionInput } from "./reply/agent-runner-question-input.js";
import type { DispatchReplyFromConfig } from "./reply/dispatch-from-config.types.js";
import { createQueueTestRun } from "./reply/queue.test-helpers.js";
import { REPLY_OPERATION_RUN_STATE } from "./reply/reply-operation-run-state.js";
import { createReplyOperation } from "./reply/reply-run-registry.js";
import { prepareReplyToolAuthority } from "./reply/reply-tool-authority.js";
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
    operation: ReturnType<typeof createReplyOperation>;
    run: ReturnType<typeof createQueueTestRun>;
  }) => Promise<void>,
  uncertain = false,
) {
  const broker = new EmbeddedQuestionBroker();
  const previousEmbeddedMode = isEmbeddedMode();
  setEmbeddedMode(true);
  setEmbeddedQuestionBroker(broker);
  const run = createQueueTestRun({ prompt: "Continue" });
  Object.assign(run.run, {
    agentId: "main",
    sessionKey,
    messageProvider: "whatsapp",
    agentAccountId: "default",
    chatType: "direct",
  });
  const operation = createReplyOperation({
    sessionKey,
    sessionId: run.run.sessionId,
    resetTriggered: false,
  });
  operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
  const fingerprint = operation.bindToolAuthorityRoute({
    provider: run.run.provider,
    model: run.run.model,
  });
  const runId = "question-order-owner";
  const admission = prepareAgentRunAdmission({
    cfg: run.run.config,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      agentId: "main",
      runId,
      ingress: { kind: "system", state: "present", boundary: "question-order-test" },
    },
  });
  try {
    await withPreparedEmbeddedRunToolAuthority(
      {
        admittedRunContext: await admission.admit("embedded", "question-order-test"),
        replyOperation: operation,
      },
      {
        ...run.run,
        runId,
        modelId: run.run.model,
        toolAuthorityFingerprint: fingerprint,
        abortSignal: operation.abortSignal,
      },
      undefined,
      async () => {
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
      },
    );
  } finally {
    broker.stop();
    clearEmbeddedQuestionBroker(broker);
    setEmbeddedMode(previousEmbeddedMode);
    operation.complete();
    admission.close();
  }
}

afterEach(() => {
  resetGlobalHookRunner();
});

describe("routed channel question input delivery order", () => {
  it.each(["correction", "cancelled-correction", "answered"] as const)(
    "settles %s while the question creator remains open and keeps ordinary replies in order",
    async (outcome) => {
      await withQuestion(async ({ broker, operation, run }) => {
        const originalStarted = createDeferred();
        const releaseOriginal = createDeferred();
        const ordinaryStarted = createDeferred();
        const releaseOrdinary = createDeferred();
        const newestStarted = createDeferred();
        const deliveries: string[] = [];
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
              commandBody: outcome === "answered" ? "Continue" : "maybe",
              followupRun: run,
              sessionKey,
              sessionCtx: params.ctx,
              opts: params.replyOptions,
            });
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
        const dispatch = (messageId: string) =>
          dispatchInboundMessageWithRoutedChannelDispatcher({
            ctx: buildTestCtx({
              SessionKey: sessionKey,
              AccountId: "default",
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
              ...(messageId === "answer"
                ? { beforeDeliver, onBeforeDeliverCancelled: cancelled, onSettled: questionSettled }
                : {}),
            },
          });
        const pending: Promise<unknown>[] = [];
        try {
          const original = dispatch("original");
          pending.push(original);
          await originalStarted.promise;
          const ordinary = dispatch("ordinary");
          pending.push(ordinary);
          await ordinaryStarted.promise;
          const answer = dispatch("answer");
          pending.push(answer);
          const newest = dispatch("newest");
          pending.push(newest);
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
        } finally {
          releaseOriginal.resolve();
          releaseOrdinary.resolve();
          await Promise.allSettled(pending);
        }
      });
    },
  );

  it.each(["forbidden", "uncertain", "terminal"] as const)(
    "keeps %s question input behind the original foreground reply",
    async (outcome) => {
      await withQuestion(async ({ broker, run }) => {
        const originalStarted = createDeferred();
        const releaseOriginal = createDeferred();
        const answerClassified = createDeferred();
        const deliveries: string[] = [];
        const settled = vi.fn();
        const dispatchReplyFromConfig: DispatchReplyFromConfig = async (params) => {
          if (params.ctx.MessageSid === "original") {
            originalStarted.resolve();
            await releaseOriginal.promise;
            params.dispatcher.sendFinalReply({ text: "original" });
          } else {
            const result = await runReplyQuestionInput({
              commandBody: "Continue",
              followupRun: { ...run, toolsAllow: outcome === "forbidden" ? [] : undefined },
              sessionKey,
              sessionCtx: params.ctx,
              opts: params.replyOptions,
            });
            if (outcome === "terminal") {
              expect(result).toEqual({ handled: false });
            } else {
              expect(result).toMatchObject({ handled: true, payload: { isError: true } });
            }
            params.dispatcher.sendFinalReply({ text: "answer status", isError: true });
            answerClassified.resolve();
          }
          return dispatchResult(true);
        };
        const dispatch = (messageId: string) =>
          dispatchInboundMessageWithRoutedChannelDispatcher({
            ctx: buildTestCtx({
              SessionKey: sessionKey,
              AccountId: "default",
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
              ...(messageId === "answer" ? { onSettled: settled } : {}),
            },
          });
        const pending: Promise<unknown>[] = [];
        try {
          const original = dispatch("original");
          pending.push(original);
          await originalStarted.promise;
          if (outcome === "terminal") {
            broker.resolve({ id: questionId, cancel: true });
          }
          const answer = dispatch("answer");
          pending.push(answer);
          await withTestTimeout(
            answerClassified.promise,
            1_000,
            "question input was not classified",
          );
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(deliveries).toEqual([]);
          expect(settled).not.toHaveBeenCalled();
          releaseOriginal.resolve();
          await Promise.all([original, answer]);
          expect(deliveries).toEqual(["original", "answer status"]);
          expect(settled).toHaveBeenCalledOnce();
        } finally {
          releaseOriginal.resolve();
          await Promise.allSettled(pending);
        }
      }, outcome === "uncertain");
    },
  );
});
