import { describe, expect, it, vi } from "vitest";
import type { QuestionWaitAnswerResult } from "../../../packages/gateway-protocol/src/index.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
  withTestTimeout,
} from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  claimEmbeddedPendingUserInputAnswer,
  steerActiveSessionWithOptionalDeliveryWait,
} from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import { expectPendingQuestionAnswerClaimable } from "../../agents/harness/gateway-question-claim.test-support.js";
import {
  QuestionAnswerUnconfirmedError,
  type AgentQuestionDispatcher,
} from "../../agents/harness/gateway-question-dispatch.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import {
  callGatewayTool,
  withQuestionGateway,
} from "../../agents/harness/gateway-question.test-support.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import type { ReplyBackendQueueMessageResult } from "../../sessions/session-controller.contracts.js";
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
type QueueOptions = Parameters<typeof steerActiveSessionWithOptionalDeliveryWait>[2];
type SteerParams = Parameters<typeof runActiveReplySteer>[0];

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
  it("leaves unmatched hidden-run input in visible FIFO followups", async ({ signal }) => {
    const key = "agent:main:hidden-followup";
    const first = createQueueTestRun({ prompt: "first input", messageId: "hidden-first" });
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
    try {
      await withQuestionCreator(key, first, async (operation, fingerprint) => {
        const queueMessage = vi.fn(async () => {});
        attachSteerBackend(operation, fingerprint, {
          runId: "accepted-backing-work",
          queueMessage,
          claimPendingUserInputAnswer: (message, options, assertCurrent, kind) =>
            claimEmbeddedPendingUserInputAnswer(message, options, key, undefined, {
              kind,
              assertCurrent,
            }),
        });
        registerAgentRunContext("accepted-backing-work", {
          isControlUiVisible: false,
          projectSessionMessages: false,
        });
        for (const run of [
          first,
          { ...first, prompt: "second input", messageId: "hidden-second" },
        ]) {
          const state: ReplyOperationRunState = {};
          await startSteer(key, run, operation, followup, state);
          expect(state.admission).toEqual({
            status: "accepted",
            mode: "followup",
            reason: "steering-unavailable",
          });
        }
        expect(queueMessage).not.toHaveBeenCalled();
        operation.complete();
      });
      // The creator callback retains real execution custody until it returns.
      await withinTest(firstEntered.promise, signal);
      expect(followup).toHaveBeenCalledOnce();
      expect(followup.mock.calls[0]?.[0].prompt).toBe("first input");
      releaseFirst.resolve();
      await withinTest(secondEntered.promise, signal);
      expect(followup.mock.calls.map(([run]) => run.prompt)).toEqual([
        "first input",
        "second input",
      ]);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled(followup.mock.results.map((result) => result.value));
      clearAgentRunContext("accepted-backing-work");
      clearSessionQueues([key]);
    }
  });

  it("cancels a waiting steer without waiting for its predecessor's acceptance", async () => {
    const key = "agent:main:waiting-steer-abort";
    const first = createQueueTestRun({ prompt: "first input", messageId: "first-input" });
    await withQuestionCreator(key, first, async (operation, fingerprint) => {
      const backendEntered = createDeferred();
      const firstOutcome = createDeferred();
      const firstAdopted = vi.fn(async () => {});
      const firstAbandoned = vi.fn();
      const secondDeferred = createDeferred();
      const source = new AbortController();
      const abandoned = vi.fn();
      const settled = vi.fn();
      const adopted = vi.fn(async () => {});
      const followup = vi.fn(async (_run: FollowupRun) => {});
      first.turnAdoptionLifecycle = { onAdopted: firstAdopted, onAbandoned: firstAbandoned };
      const second: FollowupRun = {
        ...first,
        prompt: "waiting input",
        messageId: "waiting-input",
        abortSignal: source.signal,
        turnAdoptionLifecycle: {
          onDeferred: () => secondDeferred.resolve(),
          onAdopted: adopted,
          onAbandoned: abandoned,
          onSettled: settled,
        },
      };
      const queueMessage = vi.fn((_message: string) => {
        backendEntered.resolve();
        // No acceptance callback yet: the next parked input must wait for this outcome.
        return firstOutcome.promise;
      });
      attachSteerBackend(operation, fingerprint, {
        runId: "accepted-backing-work",
        queueMessage,
      });
      const firstSteer = startSteer(key, first, operation, followup);
      let waitingSteer: ReturnType<typeof startSteer> | undefined;
      try {
        await Promise.race([
          backendEntered.promise,
          firstSteer.then(() => {
            throw new Error("first steer did not reach backend injection");
          }),
        ]);
        waitingSteer = startSteer(key, second, operation, followup);
        await secondDeferred.promise;
        source.abort(new Error("cancel source waiting for predecessor acceptance"));
        await expect(
          withTestTimeout(waitingSteer, 1_000, "cancelled steer still waits for predecessor"),
        ).resolves.toBe("handled");
        expect(abandoned).toHaveBeenCalledOnce();
        expect(settled).toHaveBeenCalledOnce();
        expect(adopted).not.toHaveBeenCalled();
        expect(firstAdopted).not.toHaveBeenCalled();
        expect(firstAbandoned).not.toHaveBeenCalled();
        expect(queueMessage.mock.calls.map(([message]) => message)).toEqual(["first input"]);
        expect(
          enqueueFollowupRun(
            key,
            createQueueTestRun({ prompt: "waiting input", messageId: second.messageId }),
            { mode: "followup", debounceMs: 0 },
            "message-id",
            followup,
            false,
          ),
        ).toBe(true);
      } finally {
        firstOutcome.resolve();
        await Promise.allSettled([firstSteer, waitingSteer]);
        clearSessionQueues([key]);
      }
    });
  });

  it.each(["confirmed", "unconfirmed", "backend-error"] as const)(
    "retains accepted input until its %s outcome settles",
    async (confirmation) => {
      const key = `agent:main:accepted-steer-abort-${confirmation}`;
      const run = createQueueTestRun({ prompt: text, messageId: `accepted-${confirmation}` });
      await withQuestionCreator(key, run, async (operation, fingerprint) => {
        const source = new AbortController();
        const accepted = createDeferred();
        const delivery = createDeferred<void | ReplyBackendQueueMessageResult>();
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
          enqueueFollowupRun(
            key,
            {
              ...createQueueTestRun({ prompt: text, messageId: run.messageId }),
              run: { ...run.run },
            },
            { mode: "followup", debounceMs: 0 },
            "message-id",
            followup,
            false,
          );
        try {
          await Promise.race([
            accepted.promise,
            adoption.then(() => {
              throw new Error("steering finished before backend acceptance");
            }),
          ]);
          if (confirmation !== "backend-error") {
            source.abort(new Error("source released while accepted input awaits confirmation"));
          }
          // The injection owner still holds this input; cancellation must not make it replayable.
          expect(abandoned).not.toHaveBeenCalled();
          expect(settled).not.toHaveBeenCalled();
          expect(adopted).not.toHaveBeenCalled();
          expect(tryDuplicate()).toBe(false);
          expect(followup).not.toHaveBeenCalled();
          const siblingSource = new AbortController();
          const siblingSettled = vi.fn();
          const siblingCleanup = vi.fn(async (_run: FollowupRun) => {});
          const sibling = createQueueTestRun({ prompt: "cancel sibling", messageId: "sibling" });
          sibling.run = { ...run.run };
          sibling.abortSignal = siblingSource.signal;
          sibling.turnAdoptionLifecycle = { onAdopted: async () => {}, onSettled: siblingSettled };
          expect(
            enqueueFollowupRun(
              key,
              sibling,
              { mode: "followup", debounceMs: 0 },
              "message-id",
              siblingCleanup,
              false,
            ),
          ).toBe(true);
          // An ordinary source's sweep must also respect the parked injection owner.
          siblingSource.abort();
          await captureSessionControllerSourceSettlement(sibling.controllerInput!);
          expect(siblingSettled).toHaveBeenCalledOnce();
          expect(siblingCleanup).toHaveBeenCalledExactlyOnceWith(sibling);
          expect(abandoned).not.toHaveBeenCalled();
          expect(settled).not.toHaveBeenCalled();
          expect(tryDuplicate()).toBe(false);
          if (confirmation === "confirmed") {
            delivery.resolve();
            await expect(adoption).resolves.toBe("handled");
            expect(state.admission).toEqual({ status: "accepted", mode: "steer" });
          } else {
            const errorMessage =
              confirmation === "backend-error"
                ? "backend failed after accepting input"
                : "transcript confirmation lost";
            if (confirmation === "backend-error") {
              delivery.reject(new Error("backend failed after accepting input"));
            } else {
              delivery.resolve({ transcriptCommit: "unconfirmed", errorMessage });
            }
            const result = await adoption;
            expect(state.admission).toEqual({
              status: "skipped",
              reason: "question-response-indeterminate",
            });
            expect(result).toMatchObject({
              isError: true,
              text: errorMessage,
            });
          }
          expect(adopted).toHaveBeenCalledOnce();
          expect(settled).toHaveBeenCalledOnce();
          expect(abandoned).not.toHaveBeenCalled();
          expect(tryDuplicate()).toBe(false);
          expect(followup).not.toHaveBeenCalled();
          expect(cancel).not.toHaveBeenCalled();
          expect(operation.abortSignal.aborted).toBe(false);
        } finally {
          delivery.resolve();
          await adoption.catch(() => undefined);
          clearSessionQueues([key]);
        }
      });
    },
  );

  it.for(["accepted", "rejected", "indeterminate"] as const)(
    "injects the next native steer after an early ACK and keeps the first ahead through a %s outcome",
    async (outcome, { signal }) => {
      const key = "agent:main:steer-outcome-" + outcome;
      const first = createQueueTestRun({ prompt: "first", messageId: "first" });
      await withQuestionCreator(key, first, async (operation, fingerprint) => {
        // Construct before either call binds its immutable controller input.
        const second: FollowupRun = { ...first, prompt: "second", messageId: "second" };
        const accepted = createDeferred();
        const nativeOutcome = createDeferred<void | ReplyBackendQueueMessageResult>();
        const secondParked = createDeferred();
        const secondQueued = createDeferred();
        second.turnAdoptionLifecycle = {
          onDeferred: () => secondParked.resolve(),
          onAdopted: async () => {},
        };
        const abandoned = vi.fn();
        first.turnAdoptionLifecycle = { onAdopted: async () => {}, onAbandoned: abandoned };
        const followup = vi.fn(async (_run: FollowupRun) => {});
        const queueMessage = vi.fn((message: string, options: QueueOptions) => {
          if (message === "first") {
            options?.onQueueAccepted?.(true);
            accepted.resolve();
            return nativeOutcome.promise;
          }
          secondQueued.resolve();
          return Promise.resolve();
        });
        attachSteerBackend(operation, fingerprint, {
          runId: "accepted-backing-work",
          queueMessage,
        });
        const firstSteer = startSteer(key, first, operation, followup);
        let secondSteer: ReturnType<typeof startSteer> | undefined;
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              accepted.promise,
              firstSteer,
              "first steer ended before native acceptance",
            ),
            signal,
          );
          secondSteer = startSteer(key, second, operation, followup);
          await withinTest(
            awaitGateBeforeSettlement(
              secondParked.promise,
              secondSteer,
              "second steer ended before source admission",
            ),
            signal,
          );
          await withinTest(
            awaitGateBeforeSettlement(
              secondQueued.promise,
              secondSteer,
              "second steer ended before backend injection",
            ),
            signal,
          );
          // A native ACK is final FIFO placement: the owner holds the first input ahead
          // of the next and never replays it. Its commit can depend on later input.
          expect(queueMessage.mock.calls.map(([message]) => message)).toEqual(["first", "second"]);
          expect(first.controllerInput?.injection?.accepted).toBe(true);
          expect(first.controllerInput?.phase).toBe("injecting");
          await expect(secondSteer).resolves.toBe("handled");
          expect(first.controllerInput?.phase).toBe("injecting");
          if (outcome === "accepted") {
            nativeOutcome.resolve();
          } else {
            nativeOutcome.reject(
              outcome === "indeterminate"
                ? new QuestionAnswerUnconfirmedError("native input outcome unknown")
                : new Error("native queue rejected after acceptance"),
            );
          }
          await Promise.all([firstSteer, secondSteer]);
          await Promise.all(
            [first, second].map((run) =>
              captureSessionControllerSourceSettlement(run.controllerInput!),
            ),
          );
          expect(queueMessage.mock.calls.map(([message]) => message)).toEqual(["first", "second"]);
          expect(followup).not.toHaveBeenCalled();
          expect(abandoned).not.toHaveBeenCalled();
          expect(first.controllerInput?.phase).toBe("consumed");
          expect(second.controllerInput?.phase).toBe("consumed");
        } finally {
          nativeOutcome.resolve();
          await Promise.allSettled([firstSteer, secondSteer]);
          clearSessionQueues([key]);
        }
      });
    },
  );

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
            expect(legacyCall).not.toHaveBeenCalled();
            expect(adopted).not.toHaveBeenCalled();
            expect(settled).not.toHaveBeenCalled();
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
            expect(committed).not.toHaveBeenCalled();
            expect(adopted).not.toHaveBeenCalled();
            expect(settled).not.toHaveBeenCalled();
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
          const questions = [
            { id: "answer", header: "Answer", question: "Continue?", isOther: true, options: [] },
          ];
          claim = registerPendingAgentQuestion({ questionId: id, sessionKey: key, questions });
          const registration = callGatewayTool(
            "question.request",
            {},
            {
              id,
              sessionKey: key,
              timeoutMs: 60_000,
              questions: questions.map((question) => ({
                questionId: question.id,
                header: question.header,
                question: question.question,
                isOther: question.isOther,
                options: question.options,
              })),
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
          expect(followup).not.toHaveBeenCalled();
          expect(queueMessage).not.toHaveBeenCalled();
          expect(cancel).not.toHaveBeenCalled();
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
