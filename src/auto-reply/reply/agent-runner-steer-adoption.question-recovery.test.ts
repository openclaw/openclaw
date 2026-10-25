import { describe, expect, it, vi } from "vitest";
import type { QuestionWaitAnswerResult } from "../../../packages/gateway-protocol/src/index.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { expectPendingQuestionAnswerClaimable } from "../../agents/harness/gateway-question-claim.test-support.js";
import type { AgentQuestionDispatcher } from "../../agents/harness/gateway-question-dispatch.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import {
  callGatewayTool,
  withQuestionGateway,
} from "../../agents/harness/gateway-question.test-support.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import { captureSessionControllerSourceSettlement } from "../../sessions/session-controller.mailbox.js";
import { runReplyQuestionInput } from "./agent-runner-question-input.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import {
  attachSteerBackend,
  createSteerParams,
} from "./agent-runner-steer-adoption.test-support.js";
import { enqueueFollowupRun, type FollowupRun } from "./queue.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { withQuestionCreator } from "./reply-run-question.test-support.js";
import { createQueueTestRun } from "./reply-tool-authority.test-support.js";

const text = "candidate committed answer";
type SteerParams = Parameters<typeof runActiveReplySteer>[0];

function expectNotCalled(...mocks: ReturnType<typeof vi.fn>[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function enqueue(key: string, run: FollowupRun, followup: SteerParams["runFollowup"]) {
  return enqueueFollowupRun(
    key,
    run,
    { mode: "followup", debounceMs: 0 },
    "message-id",
    followup,
    false,
  );
}

function startSteer(
  key: string,
  run: FollowupRun,
  operation: SteerParams["providedReplyOperation"],
  followup: SteerParams["runFollowup"],
  state?: ReplyOperationRunState,
) {
  return runActiveReplySteer(
    createSteerParams(key, run, operation, {
      replyOperationRunState: state,
      restartRecoverySourceTurnId: run.messageId,
      runFollowup: followup,
    }),
  );
}

describe("question response custody through reply adoption", () => {
  it("retains accepted input through source and sibling cancellation until settlement", async () => {
    const key = "agent:main:accepted-steer-abort";
    const run = createQueueTestRun({ prompt: text, messageId: "accepted-input" });
    await withQuestionCreator(key, run, async (operation, fingerprint) => {
      const source = new AbortController();
      const accepted = createDeferred();
      const delivery = createDeferred();
      const adopted = vi.fn(async () => {});
      const abandoned = vi.fn();
      const settled = vi.fn();
      const cancel = vi.fn();
      const followup = vi.fn(async (_run: FollowupRun) => {});
      run.abortSignal = source.signal;
      run.turnAdoptionLifecycle = {
        onAdopted: adopted,
        onAbandoned: abandoned,
        onSettled: settled,
      };
      attachSteerBackend(operation, fingerprint, {
        runId: "accepted-backing-work",
        cancel,
        queueMessage: (_message, options, assertCurrent) => {
          assertCurrent();
          options?.onQueueAccepted?.(true);
          accepted.resolve();
          return delivery.promise;
        },
      });
      const state: ReplyOperationRunState = {};
      const adoption = startSteer(key, run, operation, followup, state);
      void adoption.catch(() => undefined);
      const tryDuplicate = () =>
        enqueue(
          key,
          {
            ...createQueueTestRun({ prompt: text, messageId: run.messageId }),
            run: { ...run.run },
          },
          followup,
        );
      try {
        await awaitGateBeforeSettlement(
          accepted.promise,
          adoption,
          "steering finished before backend acceptance",
        );
        source.abort(new Error("source released while accepted input awaits confirmation"));
        // The injection owner still holds this input; cancellation must not make it replayable.
        expectNotCalled(abandoned, settled, adopted);
        expect(tryDuplicate()).toBe(false);
        expect(followup).not.toHaveBeenCalled();
        const siblingSource = new AbortController();
        const siblingSettled = vi.fn();
        const siblingCleanup = vi.fn(async (_run: FollowupRun) => {});
        const sibling = createQueueTestRun({ prompt: "cancel sibling", messageId: "sibling" });
        sibling.run = { ...run.run };
        sibling.abortSignal = siblingSource.signal;
        sibling.turnAdoptionLifecycle = { onAdopted: async () => {}, onSettled: siblingSettled };
        expect(enqueue(key, sibling, siblingCleanup)).toBe(true);
        // An ordinary source's sweep must also respect the parked injection owner.
        siblingSource.abort();
        await captureSessionControllerSourceSettlement(sibling.controllerInput!);
        expect(siblingSettled).toHaveBeenCalledOnce();
        expect(siblingCleanup).toHaveBeenCalledExactlyOnceWith(sibling);
        expectNotCalled(abandoned, settled);
        expect(tryDuplicate()).toBe(false);
        delivery.resolve();
        await expect(adoption).resolves.toBe("handled");
        expect(state.admission).toEqual({ status: "accepted", mode: "steer" });
        expect(adopted).toHaveBeenCalledOnce();
        expect(settled).toHaveBeenCalledOnce();
        expectNotCalled(abandoned, followup, cancel);
        expect(tryDuplicate()).toBe(false);
        expect(operation.abortSignal.aborted).toBe(false);
      } finally {
        delivery.resolve();
        await adoption.catch(() => undefined);
        clearSessionQueues([key]);
      }
    });
  });

  const questionSourceAuthorityChanges = [
    "next-model",
    "tool-cap",
    "permission",
    "sender",
    "source-closure",
    "operator-source",
    "legacy-dispatcher",
  ] as const;
  it.each(questionSourceAuthorityChanges)(
    "uses creator policy and incoming source authority for %s",
    async (change) => {
      const key = `agent:main:question-caller-${change}`;
      const run = createQueueTestRun({ prompt: text });
      run.run.senderIsOwner = true;
      run.run.traceAuthorized = true;
      run.run.messageProvider = "webchat";
      run.run.config = { tools: { toolsBySender: { "*": { allow: [] } } } };
      let operatorCurrent = true;
      if (change === "operator-source") {
        run.operatorAuthority = createAdmittedRunOperatorAuthority({
          profileId: "guest",
          scopes: ["operator.write"],
          source: {},
          assertCurrent: () => {
            if (!operatorCurrent) {
              throw new Error("original operator authority revoked");
            }
          },
        });
      }
      await withQuestionCreator(key, run, async (operation) => {
        const source = new AbortController();
        const committed = vi.fn();
        const legacyCall = vi.fn(async () => ({ status: "answered" }));
        const gatewayCall: AgentQuestionDispatcher = {
          version: 2,
          call: async ({ authority }) => {
            expect(authority.kind).toBe("source-bound");
            await Promise.resolve();
            if (change === "source-closure") {
              source.abort();
            }
            if (change === "operator-source") {
              operatorCurrent = false;
            }
            if (authority.kind === "source-bound") {
              authority.assertCurrent();
            }
            committed();
            return { status: "answered" };
          },
        };
        const claim = registerPendingAgentQuestion({
          questionId: `ask_caller_${change}`,
          sessionKey: key,
          questions: [{ id: "answer", header: "Answer", question: "Continue?" }],
          gatewayCall: change === "legacy-dispatcher" ? legacyCall : gatewayCall,
          answer: Promise.resolve({ status: "pending" }),
        });
        claim.attachRegistration(Promise.resolve());
        const adopted = vi.fn(async () => {});
        const settled = vi.fn();
        const state: ReplyOperationRunState = {};
        const incoming: FollowupRun = {
          ...run,
          toolsAllow: change === "tool-cap" ? [] : undefined,
          turnAdoptionLifecycle: { onAdopted: adopted, onSettled: settled },
          run: {
            ...run.run,
            // A next-turn route never replaces the still-active question creator.
            provider: "next-provider",
            model: "next-model",
            senderIsOwner: change !== "sender",
          },
        };
        try {
          const result = await runReplyQuestionInput({
            commandBody: text,
            followupRun: incoming,
            sessionKey: key,
            sessionCtx: { Provider: "webchat", SenderId: run.run.senderId },
            sessionEntry:
              change === "permission"
                ? { sessionId: run.run.sessionId, updatedAt: 0, permissionMode: "guarded" }
                : undefined,
            opts: { abortSignal: source.signal, [REPLY_OPERATION_RUN_STATE]: state },
          });
          expect(operation.result).toBeNull();
          if (change === "legacy-dispatcher") {
            expect(result).toEqual({ handled: false });
            expectNotCalled(legacyCall, adopted, settled);
            expect(state.admission).toBeUndefined();
            await expectPendingQuestionAnswerClaimable(key, true);
          } else if (change === "next-model") {
            expect(result).toEqual({ handled: true, payload: undefined });
            expect(committed).toHaveBeenCalledOnce();
            expect(adopted).toHaveBeenCalledOnce();
            expect(settled).toHaveBeenCalledOnce();
          } else {
            expect(result).toMatchObject({ handled: true, payload: { isError: true } });
            expect(state.admission).toEqual({
              status: "skipped",
              reason: "question-response-refused",
            });
            expectNotCalled(committed, adopted, settled);
            await expectPendingQuestionAnswerClaimable(key, true);
          }
        } finally {
          claim.dispose();
        }
      });
    },
  );

  it("keeps source-bound input in visible FIFO when a V1 backend cannot answer a pending question", async ({
    signal,
  }) => {
    const key = "agent:main:question-v1-fallback";
    const id = "ask_v1_fallback";
    const first = createQueueTestRun({ prompt: text, messageId: "v1-first" });
    const firstEntered = createDeferred();
    const secondEntered = createDeferred();
    const releaseFirst = createDeferred();
    const followup = vi.fn(async (run: FollowupRun) => {
      if (run.messageId === first.messageId) {
        firstEntered.resolve();
        await releaseFirst.promise;
      } else {
        secondEntered.resolve();
      }
    });
    await withQuestionGateway(async (fixture) => {
      let claim: ReturnType<typeof registerPendingAgentQuestion> | undefined;
      let answerOutcome: Promise<unknown> | undefined;
      try {
        await withQuestionCreator(key, first, async (operation, fingerprint) => {
          // Construct both sources before either is bound to its controller input.
          const second: FollowupRun = { ...first, prompt: "next input", messageId: "v1-second" };
          const question = { header: "Answer", question: "Continue?", isOther: true, options: [] };
          claim = registerPendingAgentQuestion({
            questionId: id,
            sessionKey: key,
            questions: [{ id: "answer", ...question }],
          });
          const registration = callGatewayTool(
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
          await withinTest(registration, signal);
          const answer = callGatewayTool(
            "question.waitAnswer",
            { timeoutMs: 70_000 },
            { id, timeoutMs: 60_000, includeResolutionId: true },
          ) as Promise<QuestionWaitAnswerResult>;
          answerOutcome = answer.catch(() => undefined);
          claim.setAnswer(answer);
          await withinTest(fixture.waitStarted, signal);
          const cancel = vi.fn(() => fixture.backingRun.abort());
          const queueMessage = vi.fn(async () => {
            throw new Error("V1 backend must not receive source-bound question input");
          });
          operation.attachBackend({
            kind: "embedded",
            runId: "accepted-backing-work",
            toolAuthorityFingerprint: fingerprint,
            supportsTranscriptCommitWait: true,
            cancel,
            messageInjection: { isAvailable: () => true, queueMessage },
          });
          operation.setPhase("running");
          for (const run of [first, second]) {
            const state: ReplyOperationRunState = {};
            await withinTest(startSteer(key, run, operation, followup, state), signal);
            expect(state.admission).toEqual({
              status: "accepted",
              mode: "followup",
              reason: "steering-unavailable",
            });
          }
          expect(getExistingFollowupQueue(key)?.items.map((run) => run.prompt)).toEqual([
            text,
            "next input",
          ]);
          expectNotCalled(followup, queueMessage, cancel);
          expect(operation.abortSignal.aborted).toBe(false);
          expect(fixture.backingRun.signal.aborted).toBe(false);
          expect(
            fixture.requests.filter((request) => request.method === "question.resolve"),
          ).toEqual([]);
          expect(getSessionControllerOperation(key)).toBe(operation);
          expect(fixture.manager.get(id)?.status).toBe("pending");
          await expectPendingQuestionAnswerClaimable(key, true);
          operation.complete();
        });
        await withinTest(firstEntered.promise, signal);
        expect(followup).toHaveBeenCalledOnce();
        expect(followup.mock.calls[0]?.[0].prompt).toBe(text);
        releaseFirst.resolve();
        await withinTest(secondEntered.promise, signal);
        expect(followup.mock.calls.map(([run]) => run.prompt)).toEqual([text, "next input"]);
        expect(fixture.manager.get(id)?.status).toBe("pending");
      } finally {
        releaseFirst.resolve();
        if (fixture.manager.get(id)?.status === "pending") {
          fixture.manager.cancel(id, "test-cleanup");
        }
        await answerOutcome;
        claim?.dispose();
        await Promise.allSettled(followup.mock.results.map((result) => result.value));
        clearSessionQueues([key]);
      }
    });
    expect(getSessionControllerOperation(key)).toBeUndefined();
    expect(getExistingFollowupQueue(key)).toBeUndefined();
  });
});
