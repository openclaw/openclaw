import { expect, it, vi, type MockInstance } from "vitest";
import type { QuestionWaitAnswerResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
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
import {
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { runReplyQuestionInput } from "./agent-runner-question-input.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import {
  attachSteerBackend,
  createSteerParams,
  createReplyParams,
} from "./agent-runner-steer-adoption.test-support.js";
import { MessageInjectionTargetUnavailableError } from "./message-injection-authority.js";
import { enqueueFollowupRun, type FollowupRun } from "./queue.js";
import { createQueueTestRun, clearFollowupQueueForTest } from "./queue.test-helpers.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { withQuestionCreator } from "./reply-run-question.test-support.js";
import type { ReplyBackendQueueMessageResult } from "./reply-run-registry.contracts.js";
import { replyRunRegistry } from "./reply-run-registry.js";
import { prepareSteeringDelivery } from "./steering-delivery-preparation.js";

const text = "candidate committed answer";
type QueueOptions = Parameters<typeof steerActiveSessionWithOptionalDeliveryWait>[2];
type SteerParams = Parameters<typeof runActiveReplySteer>[0];

function expectCalls(count: number, ...spies: MockInstance[]) {
  for (const spy of spies) {
    expect(spy).toHaveBeenCalledTimes(count);
  }
}

function observeAdoption(run: FollowupRun, onAdopted = async () => {}) {
  const adopted = vi.fn(onAdopted);
  const abandoned = vi.fn();
  const settled = vi.fn();
  run.turnAdoptionLifecycle = { onAdopted: adopted, onAbandoned: abandoned, onSettled: settled };
  return { adopted, abandoned, settled };
}

function waitForGate(gate: Promise<unknown>, pending: Promise<unknown>) {
  return Promise.race([
    gate,
    pending.then(() => {
      throw new Error("adoption settled before reaching its backend gate");
    }),
  ]);
}

function startSteer(
  key: string,
  run: FollowupRun,
  operation: SteerParams["providedReplyOperation"],
  followup: SteerParams["runFollowup"],
  state?: ReplyOperationRunState,
  storePath?: string,
) {
  return runActiveReplySteer(
    createSteerParams(key, run, operation, {
      replyOperationRunState: state,
      restartRecoverySourceTurnId: run.messageId,
      runFollowup: followup,
      storePath,
    }),
  );
}

function enqueue(key: string, run: FollowupRun, followup?: SteerParams["runFollowup"]) {
  return enqueueFollowupRun(key, run, { mode: "followup", debounceMs: 0 }, "message-id", followup);
}

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

it("leaves unmatched hidden-run input in visible FIFO followups", async () => {
  const key = "agent:main:hidden-followup";
  const first = createQueueTestRun({ prompt: "first input", messageId: "hidden-first" });
  await withQuestionCreator(key, first, async (operation, fingerprint) => {
    const queueMessage = vi.fn(async () => {});
    const firstEntered = createDeferred();
    const releaseFirst = createDeferred();
    const followup = vi.fn(async (run: FollowupRun) => {
      if (run.messageId === first.messageId) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
    });
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
    try {
      for (const run of [first, { ...first, prompt: "second input", messageId: "hidden-second" }]) {
        const state: ReplyOperationRunState = {};
        await startSteer(key, run, operation, followup, state);
        expect(state.admission).toEqual({ status: "accepted", mode: "followup" });
      }
      expect(queueMessage).not.toHaveBeenCalled();
      operation.complete();
      await withTestTimeout(firstEntered.promise, 1_000, "first followup was not dispatched");
      expect(followup).toHaveBeenCalledOnce();
      expect(followup.mock.calls[0]?.[0].prompt).toBe("first input");
      releaseFirst.resolve();
      await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(2));
      expect(followup.mock.calls.map(([run]) => run.prompt)).toEqual([
        "first input",
        "second input",
      ]);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled(followup.mock.results.map((result) => result.value));
      clearAgentRunContext("accepted-backing-work");
      clearFollowupQueueForTest(key);
    }
  });
});

it("cancels a waiting steer without waiting for its predecessor's acceptance", async () => {
  const key = "agent:main:waiting-steer-abort";
  const first = createQueueTestRun({ prompt: "first input", messageId: "first-input" });
  await withQuestionCreator(key, first, async (operation, fingerprint) => {
    const backendEntered = createDeferred();
    const firstOutcome = createDeferred();
    const firstAdopted = vi.fn(async () => {});
    const firstAbandoned = vi.fn();
    first.turnAdoptionLifecycle = { onAdopted: firstAdopted, onAbandoned: firstAbandoned };
    const secondDeferred = createDeferred();
    const source = new AbortController();
    const followup = vi.fn(async (_run: FollowupRun) => {});
    const second: FollowupRun = {
      ...first,
      prompt: "waiting input",
      messageId: "waiting-input",
      abortSignal: source.signal,
    };
    const { adopted, abandoned, settled } = observeAdoption(second);
    second.turnAdoptionLifecycle!.onDeferred = () => secondDeferred.resolve();
    const queueMessage = vi.fn((_message: string) => {
      backendEntered.resolve();
      // No acceptance callback yet: the next parked input must wait for this outcome.
      return firstOutcome.promise;
    });
    attachSteerBackend(operation, fingerprint, { queueMessage, runId: "accepted-backing-work" });
    const firstSteer = startSteer(key, first, operation, followup);
    let waitingSteer: ReturnType<typeof startSteer> | undefined;
    try {
      await waitForGate(backendEntered.promise, firstSteer);
      waitingSteer = startSteer(key, second, operation, followup);
      await secondDeferred.promise;
      source.abort(new Error("cancel source waiting for predecessor acceptance"));
      await expect(
        withTestTimeout(waitingSteer, 1_000, "cancelled steer still waits for predecessor"),
      ).resolves.toBe("handled");
      expectCalls(1, abandoned, settled);
      expectCalls(0, adopted, firstAdopted, firstAbandoned);
      expect(queueMessage.mock.calls.map(([message]) => message)).toEqual(["first input"]);
      const retry = createQueueTestRun({ prompt: second.prompt, messageId: second.messageId });
      expect(enqueue(key, retry, followup)).toBe(true);
    } finally {
      firstOutcome.resolve();
      await Promise.allSettled([firstSteer, waitingSteer]);
      clearFollowupQueueForTest(key);
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
      const { adopted, abandoned, settled } = observeAdoption(run);
      const cancel = vi.fn();
      const followup = vi.fn(async (_run: FollowupRun) => {});
      run.abortSignal = source.signal;
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
        enqueue(key, createQueueTestRun({ prompt: text, messageId: run.messageId }), followup);
      try {
        await waitForGate(accepted.promise, adoption);
        if (confirmation !== "backend-error") {
          source.abort(new Error("source released while accepted input awaits confirmation"));
        }
        // The injection owner still holds this input; cancellation must not make it replayable.
        expectCalls(0, abandoned, settled, adopted);
        expect(tryDuplicate()).toBe(false);
        expect(followup).not.toHaveBeenCalled();
        const siblingSource = new AbortController();
        const siblingSettled = vi.fn();
        const siblingCleanup = vi.fn(async (_run: FollowupRun) => {});
        const sibling = createQueueTestRun({ prompt: "cancel sibling", messageId: "sibling" });
        sibling.abortSignal = siblingSource.signal;
        sibling.turnAdoptionLifecycle = { onAdopted: async () => {}, onSettled: siblingSettled };
        expect(enqueue(key, sibling, siblingCleanup)).toBe(true);
        // An ordinary source's sweep must also respect the parked injection owner.
        siblingSource.abort();
        expect(siblingSettled).toHaveBeenCalledOnce();
        expect(siblingCleanup).toHaveBeenCalledExactlyOnceWith(sibling);
        expectCalls(0, abandoned, settled);
        expect(tryDuplicate()).toBe(false);
        if (confirmation === "confirmed") {
          delivery.resolve();
          await expect(adoption).resolves.toBe("handled");
          expect(state.admission).toEqual({ status: "accepted", mode: "steer" });
        } else {
          const errorMessage =
            confirmation === "backend-error" ? "backend failed" : "transcript lost";
          if (confirmation === "backend-error") {
            delivery.reject(new Error(errorMessage));
          } else {
            delivery.resolve({ transcriptCommit: "unconfirmed", errorMessage });
          }
          const result = await adoption;
          expect(state.admission).toEqual({
            status: "skipped",
            reason: "question-response-indeterminate",
          });
          expect(result).toMatchObject({ isError: true, text: errorMessage });
        }
        expectCalls(1, adopted, settled);
        expect(tryDuplicate()).toBe(false);
        expectCalls(0, abandoned, followup, cancel);
        expect(operation.abortSignal.aborted).toBe(false);
      } finally {
        delivery.resolve();
        await adoption.catch(() => undefined);
        clearFollowupQueueForTest(key);
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
      const state: ReplyOperationRunState = {};
      const incoming: FollowupRun = {
        ...run,
        toolsAllow: change === "tool-cap" ? [] : undefined,
        run: {
          ...run.run,
          // A next-turn route never replaces the still-active question creator.
          provider: "next-provider",
          model: "next-model",
          senderIsOwner: change !== "sender",
        },
      };
      const adopted = vi.fn(async () => {});
      const settled = vi.fn();
      incoming.turnAdoptionLifecycle = { onAdopted: adopted, onSettled: settled };
      try {
        const result = await runReplyQuestionInput({
          commandBody: text,
          followupRun: incoming,
          sessionKey: key,
          sessionCtx: { Provider: "webchat" },
          sessionEntry:
            change === "permission"
              ? { sessionId: run.run.sessionId, updatedAt: 0, permissionMode: "guarded" }
              : undefined,
          opts: { abortSignal: source.signal, [REPLY_OPERATION_RUN_STATE]: state },
        });
        expect(operation.result).toBeNull();
        if (change === "legacy-dispatcher") {
          expect(result).toEqual({ handled: false });
          expectCalls(0, legacyCall, adopted, settled);
          expect(state.admission).toBeUndefined();
          await expectPendingQuestionAnswerClaimable(key, true);
        } else if (change === "next-model") {
          expect(result).toEqual({ handled: true, payload: undefined });
          expectCalls(1, committed, adopted, settled);
        } else {
          expect(result).toMatchObject({ handled: true, payload: { isError: true } });
          expect(state.admission).toEqual({
            status: "skipped",
            reason: "question-response-refused",
          });
          expectCalls(0, committed, adopted, settled);
          await expectPendingQuestionAnswerClaimable(key, true);
        }
      } finally {
        claim.dispose();
      }
    });
  },
);

it.each([
  ["delayed-receipt", "steer", false],
  ["delayed-receipt", "reply", false],
  ["failed-waiter", "steer", false],
  ["failed-waiter", "steer", true],
  ["failed-waiter", "reply", false],
  ["legacy-receipt", "steer", false],
  ["legacy-receipt", "steer", true],
  ["legacy-receipt", "reply", false],
  ["v1-negative", "steer", false],
  ["closed-adoption", "steer", false],
  ["closed-adoption", "reply", false],
  ["confirmed-closed-adoption", "steer", false],
  ["confirmed-closed-adoption", "steer", true],
  ["confirmed-closed-adoption", "reply", false],
  ["late-receipt", "steer", false],
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
        const receiptScope =
          mode === "late-receipt"
            ? {
                agentId: "main",
                sessionKey: key,
                storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
              }
            : undefined;
        if (receiptScope) {
          run.abortSignal = operation.abortSignal;
          await upsertSessionEntryCore(receiptScope, {
            sessionId: run.run.sessionId,
            updatedAt: 1,
          });
        }
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
        const { adopted, abandoned, settled } = observeAdoption(run, async () => {
          if (mode === "closed-adoption" || mode === "confirmed-closed-adoption") {
            throw new Error("source adoption closed after dispatch");
          }
        });
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
          try {
            if (receiptScope) {
              assertCurrent();
              await updateSessionEntry(receiptScope, () => ({
                restartRecoveryDeliveryReceiptState: "terminal-pending",
              }));
            }
            return await steerActiveSessionWithOptionalDeliveryWait(
              { steer: nativeSteer, subscribe },
              message,
              options,
              key,
              () => {
                assertCurrent();
                return true;
              },
              { kind, assertCurrent },
            );
          } catch (error) {
            if (mode === "v1-negative") {
              options?.onQueueAccepted?.(false);
            }
            throw error;
          }
        };
        const assertCurrent = () => {
          expect(replyRunRegistry.get(key)).toBe(operation);
          operation.abortSignal.throwIfAborted();
        };
        const backend = {
          runId: "accepted-backing-work",
          cancel,
        };
        if (entrypoint === "steer" && mode !== "v1-negative") {
          attachSteerBackend(operation, fingerprint, {
            ...backend,
            queueMessage: queue,
            claimPendingUserInputAnswer: (message, options, current, kind) =>
              claimEmbeddedPendingUserInputAnswer(
                message,
                options,
                key,
                () => {
                  current();
                  return true;
                },
                { kind, assertCurrent: current },
              ),
          });
        } else {
          operation.attachBackend({
            ...backend,
            kind: entrypoint === "reply" ? "cli" : "embedded",
            toolAuthorityFingerprint: fingerprint,
            ...(entrypoint === "reply"
              ? {}
              : {
                  messageInjection: {
                    isAvailable: () => true,
                    queueMessage: (message, options) =>
                      queue(message, options, assertCurrent, "run"),
                  },
                }),
          });
          operation.setPhase("running");
        }
        if (hidden) {
          registerAgentRunContext("accepted-backing-work", {
            isControlUiVisible: false,
            projectSessionMessages: false,
          });
        }
        const confirmed = ["delayed-receipt", "confirmed-closed-adoption", "late-receipt"].includes(
          mode,
        );
        if (mode !== "confirmed-closed-adoption" && mode !== "late-receipt") {
          fixture.dropNextResolveResponse();
        }
        const state: ReplyOperationRunState = {};
        const followup = vi.fn(async (_run: FollowupRun) => {});
        let done = false;
        const adoption = (
          entrypoint === "reply"
            ? runReplyAgent(
                createReplyParams(run, {
                  opts: {
                    [REPLY_OPERATION_RUN_STATE]: state,
                    turnAdoptionLifecycle: run.turnAdoptionLifecycle,
                  },
                  resolvedQueue: { mode: "steer", debounceMs: 0 },
                  shouldSteer: true,
                  isActive: true,
                  defaultModel: "openai/gpt-test",
                  resolvedBlockStreamingBreak: "text_end",
                }),
              )
            : startSteer(key, run, operation, followup, state, receiptScope?.storePath)
        ).finally(() => {
          done = true;
        });
        void adoption.catch(() => undefined);
        try {
          await waitForGate(hold.entered, adoption);
          const resolves = fixture.requests.filter(
            (request) => request.method === "question.resolve",
          );
          const wait = fixture.requests.find((request) => request.method === "question.waitAnswer");
          expect(resolves).toHaveLength(1);
          const receipt = await fixture.manager.waitAnswer(id, undefined, true);
          expect(receipt).toMatchObject({
            status: "answered",
            answers: { answers: { answer: [text] } },
          });
          if (mode === "legacy-receipt") {
            expect(resolves[0]?.params).not.toHaveProperty("resolutionId");
            expect(wait?.params).not.toHaveProperty("includeResolutionId");
            expect(receipt).not.toHaveProperty("resolutionId");
          } else {
            const resolveParams = resolves[0]?.params as { resolutionId?: string } | undefined;
            const resolutionId = resolveParams?.resolutionId;
            expect(resolutionId).toMatch(/^[a-f0-9]{32}$/);
            expect(receipt).toMatchObject({ resolutionId });
            expect(wait?.params).toMatchObject({ includeResolutionId: true });
          }
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
          if (receiptScope) {
            const delivery = prepareSteeringDelivery({
              ...receiptScope,
              sessionId: run.run.sessionId,
              assertCurrent,
            });
            try {
              await expect(delivery.prepareCurrent()).rejects.toBeInstanceOf(
                MessageInjectionTargetUnavailableError,
              );
            } finally {
              delivery.release();
            }
            expect(nativeSteer).not.toHaveBeenCalled();
          }
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
            expect.soft(enqueue(key, { ...run })).toBe(false);
          }
        } finally {
          hold.release();
          if (fixture.manager.get(id)?.status === "pending") {
            fixture.manager.cancel(id, "test-cleanup");
          }
          await answerOutcome;
          await adoption.catch(() => undefined);
          claim.dispose();
          clearFollowupQueueForTest(key);
          if (hidden) {
            clearAgentRunContext("accepted-backing-work");
          }
        }
      }),
    );
    expect(replyRunRegistry.get(key)).toBeUndefined();
    expect(getExistingFollowupQueue(key)).toBeUndefined();
  },
);
