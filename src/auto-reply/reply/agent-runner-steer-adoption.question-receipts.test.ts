import { expect, it, vi } from "vitest";
import type { QuestionWaitAnswerResult } from "../../../packages/gateway-protocol/src/index.js";
import {
  claimEmbeddedPendingUserInputAnswer,
  steerActiveSessionWithOptionalDeliveryWait,
} from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import { expectPendingQuestionAnswerClaimable } from "../../agents/harness/gateway-question-claim.test-support.js";
import type { AgentQuestionDispatcher } from "../../agents/harness/gateway-question-dispatch.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import {
  callGatewayTool,
  withQuestionGateway,
} from "../../agents/harness/gateway-question.test-support.js";
import type { GatewayQuestionCall } from "../../agents/tools/gateway-question-lifecycle.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import {
  captureSessionControllerSourceSettlement,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import { createSteerParams } from "./agent-runner-steer-adoption.test-support.js";
import { enqueueFollowupRun, type FollowupRun } from "./queue.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { withQuestionCreator } from "./reply-run-question.test-support.js";
import { createQueueTestRun } from "./reply-tool-authority.test-support.js";
import { createMockTypingController, createReplyParams } from "./test-helpers.js";

const text = "candidate committed answer";
type QueueOptions = Parameters<typeof steerActiveSessionWithOptionalDeliveryWait>[2];
const allowCurrent = (assertCurrent: () => void) => () => {
  assertCurrent();
  return true;
};

// A V1 translator built against v2026.8.2's closed request schemas. The real
// transport/manager still commits and answers; only new receipt fields are absent.
const legacyGateway: GatewayQuestionCall = (method, options, params, extra) => {
  const input = params as Record<string, unknown>;
  const forwarded =
    method === "question.resolve"
      ? { id: input.id, answers: input.answers, resolvedBy: input.resolvedBy }
      : method === "question.waitAnswer"
        ? { id: input.id, timeoutMs: input.timeoutMs }
        : params;
  return callGatewayTool(method, options, forwarded, extra);
};

// Old wire schemas do not remove the modern host's final-dispatch obligation.
const legacyDispatcher: AgentQuestionDispatcher = {
  version: 2,
  call: ({ method, options, params, signal, authority }) =>
    legacyGateway(method, options, params, {
      signal,
      ...(authority.kind === "source-bound"
        ? { dispatchAuthority: { version: 2, ...authority } }
        : {}),
    }),
};

it.each([
  ["delayed-receipt", "steer", false],
  ["delayed-receipt", "reply", false],
  ["failed-waiter", "steer", false],
  ["failed-waiter", "steer", true],
  ["failed-waiter", "reply", false],
  ["legacy-receipt", "steer", false],
  ["legacy-receipt", "steer", true],
  ["legacy-receipt", "reply", false],
  ["closed-adoption", "steer", false],
  ["closed-adoption", "reply", false],
  ["confirmed-closed-adoption", "steer", false],
  ["confirmed-closed-adoption", "steer", true],
  ["confirmed-closed-adoption", "reply", false],
] as const)(
  "does not replay or abort independent work after %s/%s (hidden=%s)",
  async (mode, entrypoint, hidden) => {
    const key = `agent:main:question-recovery-${entrypoint}-${mode}-${hidden}`;
    const id = `ask_recovery_${entrypoint}_${mode}_${hidden}`;
    const run = createQueueTestRun({
      prompt: text,
      messageId: `recovery-${entrypoint}-${mode}-${hidden}`,
    });
    await withQuestionGateway(async (fixture) =>
      withQuestionCreator(key, run, async (operation, fingerprint) => {
        const hold = fixture.holdWaitAnswerResponse();
        const call = mode === "legacy-receipt" ? legacyGateway : callGatewayTool;
        const question = { header: "Answer", question: "Continue?", isOther: true, options: [] };
        const claim = registerPendingAgentQuestion({
          questionId: id,
          sessionKey: key,
          questions: [{ id: "answer", ...question }],
          gatewayCall: mode === "legacy-receipt" ? legacyDispatcher : undefined,
        });
        const registration = call(
          "question.request",
          {},
          {
            id,
            sessionKey: key,
            timeoutMs: 60_000,
            questions: [{ questionId: "answer", ...question }],
          },
        );
        claim.attachRegistration(registration);
        await registration;
        const answer = call(
          "question.waitAnswer",
          { timeoutMs: 70_000 },
          { id, timeoutMs: 60_000, includeResolutionId: true },
        ) as Promise<QuestionWaitAnswerResult>;
        const answerOutcome = answer.catch(() => undefined);
        claim.setAnswer(answer);
        await fixture.waitStarted;
        const abandoned = vi.fn();
        const settled = vi.fn();
        const adopted = vi.fn(async () => {
          if (mode === "closed-adoption" || mode === "confirmed-closed-adoption") {
            throw new Error("source adoption closed after dispatch");
          }
        });
        run.turnAdoptionLifecycle = {
          onAdopted: adopted,
          onAbandoned: abandoned,
          onSettled: settled,
        };
        const cancel = vi.fn(() => fixture.backingRun.abort());
        const nativeSteer = vi.fn(async () => {
          throw new Error("unexpected ordinary steering of an answered question");
        });
        const subscribe = vi.fn(() => () => {});
        const queue = async (
          message: string,
          options: QueueOptions,
          assertCurrent: () => void,
          kind: "run" | "source-bound",
        ) => {
          return await steerActiveSessionWithOptionalDeliveryWait(
            { steer: nativeSteer, subscribe },
            message,
            options,
            key,
            allowCurrent(assertCurrent),
            { kind, assertCurrent },
          );
        };
        operation.attachBackend({
          kind: entrypoint === "reply" ? "cli" : "embedded",
          runId: "accepted-backing-work",
          toolAuthorityFingerprint: fingerprint,
          supportsTranscriptCommitWait: true,
          cancel,
          ...(entrypoint === "reply"
            ? {}
            : {
                messageInjectionV2: {
                  version: 2 as const,
                  isAvailable: () => true,
                  queueMessage: queue,
                  claimPendingUserInputAnswer: (message, options, current, kind) =>
                    claimEmbeddedPendingUserInputAnswer(
                      message,
                      options,
                      key,
                      allowCurrent(current),
                      { kind, assertCurrent: current },
                    ),
                },
              }),
        });
        operation.setPhase("running");
        if (hidden) {
          registerAgentRunContext("accepted-backing-work", {
            isControlUiVisible: false,
            projectSessionMessages: false,
          });
        }
        const confirmed = ["delayed-receipt", "confirmed-closed-adoption"].includes(mode);
        if (mode !== "confirmed-closed-adoption") {
          fixture.dropNextResolveResponse();
        }
        const state: ReplyOperationRunState = {};
        const followup = vi.fn(async (_run: FollowupRun) => {});
        const typing = createMockTypingController();
        const sessionCtx = { Provider: run.run.messageProvider, SenderId: run.run.senderId };
        let done = false;
        const adoption = (
          entrypoint === "reply"
            ? runReplyAgent(
                createReplyParams(run, {
                  transcriptCommandBody: run.prompt,
                  opts: {
                    [REPLY_OPERATION_RUN_STATE]: state,
                    turnAdoptionLifecycle: run.turnAdoptionLifecycle,
                  },
                  queueKey: key,
                  resolvedQueue: { mode: "steer", debounceMs: 0 },
                  shouldSteer: true,
                  isActive: true,
                  typing,
                  sessionCtx,
                  sessionKey: key,
                  defaultModel: "openai/gpt-test",
                  resolvedBlockStreamingBreak: "text_end",
                }),
              )
            : runActiveReplySteer(
                createSteerParams(key, run, operation, {
                  replyOperationRunState: state,
                  sourceTurnId: run.messageId,
                  runFollowup: followup,
                  sessionCtx,
                }),
              )
        ).finally(() => {
          done = true;
        });
        void adoption.catch(() => undefined);
        try {
          await Promise.race([
            hold.entered,
            adoption.then(() => {
              throw new Error("adoption completed before the committed waiter gate");
            }),
          ]);
          if (entrypoint === "reply") {
            const input = run.controllerInput!;
            let sourceSettled = false;
            const markSettled = () => {
              sourceSettled = true;
            };
            void captureSessionControllerSourceSettlement(input).then(markSettled, markSettled);
            // The RPC has committed, but its exact receipt/readback still owns
            // input custody. Dispatch teardown must not manufacture settlement.
            retireSessionControllerInput(input);
            await Promise.resolve();
            await Promise.resolve();
            expect(sourceSettled).toBe(false);
            expect(abandoned).not.toHaveBeenCalled();
          }
          const resolves = fixture.requests.filter(
            (request) => request.method === "question.resolve",
          );
          expect(resolves).toHaveLength(1);
          const receipt = await fixture.manager.waitAnswer(id, undefined, true);
          expect(receipt).toMatchObject({
            status: "answered",
            answers: { answers: { answer: [text] } },
          });
          expect(operation).toMatchObject({ phase: "running", result: null });
          expect(cancel).not.toHaveBeenCalled();
          if (mode === "delayed-receipt") {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 1_200);
            });
            expect(done).toBe(false);
            await expectPendingQuestionAnswerClaimable(key, false);
            expect(followup).not.toHaveBeenCalled();
            expect(cancel).not.toHaveBeenCalled();
          }
          if (confirmed || mode === "legacy-receipt") {
            hold.release();
          } else {
            hold.fail();
          }
          const result = await adoption;
          await answerOutcome;
          // Observe drainage without waiting for the replay a correct owner forbids.
          await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());
          expect.soft(followup).not.toHaveBeenCalled();
          expect.soft(cancel).not.toHaveBeenCalled();
          expect.soft(operation.abortSignal.aborted).toBe(false);
          expect.soft(fixture.backingRun.signal.aborted).toBe(false);
          expect.soft(abandoned).not.toHaveBeenCalled();
          expect.soft(adopted).toHaveBeenCalledOnce();
          expect.soft(settled).toHaveBeenCalledOnce();
          expect(nativeSteer).not.toHaveBeenCalled();
          if (confirmed) {
            expect(result).toBe(entrypoint === "reply" ? undefined : "handled");
            expect(state.admission).toEqual({ status: "accepted", mode: "steer" });
          } else {
            expect.soft(result).toMatchObject({
              isError: true,
              text: expect.stringContaining("confirmation was lost"),
            });
            expect
              .soft(state.admission)
              .toEqual({ status: "skipped", reason: "question-response-indeterminate" });
          }
          if (entrypoint === "steer") {
            const requeued = enqueueFollowupRun(
              key,
              { ...run },
              { mode: "followup", debounceMs: 0 },
              "message-id",
            );
            expect.soft(requeued).toBe(false);
          }
        } finally {
          hold.release();
          if (fixture.manager.get(id)?.status === "pending") {
            fixture.manager.cancel(id, "test-cleanup");
          }
          await answerOutcome;
          await adoption.catch(() => undefined);
          claim.dispose();
          clearSessionQueues([key]);
          if (hidden) {
            clearAgentRunContext("accepted-backing-work");
          }
        }
      }),
    );
    expect(getSessionControllerOperation(key)).toBeUndefined();
    expect(getExistingFollowupQueue(key)).toBeUndefined();
  },
);
