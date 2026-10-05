import { describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import { claimEmbeddedPendingUserInputAnswer } from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import type { AgentQuestionDispatcher } from "../../agents/harness/gateway-question-dispatch.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import {
  copyConversationBindingRouteFacts,
  withConversationBindingRouteFacts,
} from "../../channels/conversation-binding-route-facts.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import { createQueueTestRun, clearFollowupQueueForTest } from "./queue.test-helpers.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { withQuestionCreator } from "./reply-run-question.test-support.js";
import { readPreparedConversationBindingSourceRoutes } from "./session-conversation-binding.js";
import { buildTestCtx } from "./test-ctx.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

describe("queued question source ownership", () => {
  it.each([false, true, "commit"] as const)(
    "retains the prepared route when its binding changes=%s during handoff",
    async (changed) => {
      const key = `agent:main:queued-question-source-${changed}`;
      const run = createQueueTestRun({ prompt: "Continue", messageId: `answer-${changed}` });
      const conversation = { channel: "webchat", accountId: "default", conversationId: key };
      const observed: SessionBindingRecord = {
        bindingId: "observed",
        boundAt: 1,
        targetKind: "session",
        targetSessionKey: key,
        conversation,
        status: "active",
      };
      let binding = observed;
      const adapter: SessionBindingAdapter = {
        channel: conversation.channel,
        accountId: conversation.accountId,
        listBySession: () => [binding],
        inspectByConversation: () => binding,
        inspectByConversationAsync: async () => binding,
        resolveByConversation: () => binding,
        resolveByConversationAsync: async () => binding,
        touchAsync: async () => undefined,
      };
      registerSessionBindingAdapter(adapter);
      const ctx = buildTestCtx({ SessionKey: key, AgentId: "main" });
      copyConversationBindingRouteFacts(
        withConversationBindingRouteFacts(
          { sessionKey: key, agentId: "main" },
          { kind: "agent", binding: observed, sessionKey: key },
          "main",
          conversation,
        ),
        ctx,
      );
      const resolved = vi.fn();
      const nativeSteer = vi.fn();
      const followup = vi.fn();
      const abandoned = vi.fn();
      const settled = vi.fn();
      run.turnAdoptionLifecycle = {
        onAdopted: async () => {},
        onAbandoned: abandoned,
        onSettled: settled,
      };
      try {
        await withQuestionCreator(key, run, async (operation, fingerprint) => {
          operation.attachBackend({
            kind: "embedded",
            runId: "accepted-backing-work",
            toolAuthorityFingerprint: fingerprint,
            cancel: vi.fn(),
            messageInjectionV2: {
              version: 2,
              isAvailable: () => true,
              queueMessage: async (message, options, assertCurrent, kind) => {
                // No question existed at the early dispatch claim. It appears only
                // after the parked input reaches its concrete execution owner.
                const question = registerPendingAgentQuestion({
                  sessionKey: key,
                  questionId: `late-${changed}`,
                  questions: [{ id: "answer", header: "Answer", question: "Continue?" }],
                  gatewayCall: {
                    version: 2,
                    call: async (request) => {
                      if (changed === "commit") {
                        throw new GatewayClientRequestError({
                          code: "FORBIDDEN",
                          message: "Conversation binding changed",
                          details: { reason: "QUESTION_SOURCE_BINDING_CHANGED" },
                        });
                      }
                      resolved(request);
                      return {};
                    },
                  } satisfies AgentQuestionDispatcher,
                });
                question.attachRegistration(Promise.resolve());
                if (changed === true) {
                  binding = { ...observed, bindingId: "reassigned", boundAt: 2 };
                }
                try {
                  if (
                    !(await claimEmbeddedPendingUserInputAnswer(
                      message,
                      options,
                      key,
                      undefined,
                      { kind, assertCurrent },
                      fingerprint,
                    ))
                  ) {
                    nativeSteer();
                  }
                } finally {
                  question.dispose();
                }
              },
            },
          });
          operation.setPhase("running");
          const typing = createMockTypingController();
          const state: ReplyOperationRunState = {};
          const pending = runActiveReplySteer({
            followupRun: run,
            opts: undefined,
            providedReplyOperation: operation,
            queueKey: key,
            releaseAdmissionTicket: () => {},
            replyOperationRunState: state,
            resolvedQueue: { mode: "steer", debounceMs: 0 },
            restartRecoverySourceTurnId: run.messageId,
            runFollowup: followup,
            sessionCtx: ctx,
            sessionKey: key,
            touchActiveSessionEntry: async () => {},
            typing,
            typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
            toolAuthorityFingerprint: fingerprint,
          });
          if (changed) {
            await expect(pending).rejects.toMatchObject({
              ...(changed === true
                ? { code: "SESSION_WORK_START_CHANGED" }
                : { name: "QuestionDispatchRefusedError" }),
              message: expect.stringContaining("Conversation binding changed"),
            });
            expect(resolved).not.toHaveBeenCalled();
            expect(state.admission).toEqual({
              status: "skipped",
              reason: "question-response-refused",
            });
            expect(getExistingFollowupQueue(key)?.items ?? []).toEqual([]);
            expect(abandoned).toHaveBeenCalledOnce();
            expect(settled).toHaveBeenCalledOnce();
          } else {
            await expect(pending).resolves.toBe("handled");
            expect(resolved).toHaveBeenCalledOnce();
            expect(resolved.mock.calls[0]?.[0].params).toMatchObject({
              sourceBindingRoutes: readPreparedConversationBindingSourceRoutes(ctx),
            });
          }
          expect(nativeSteer).not.toHaveBeenCalled();
          expect(followup).not.toHaveBeenCalled();
        });
      } finally {
        unregisterSessionBindingAdapter({
          channel: adapter.channel,
          accountId: adapter.accountId,
          adapter,
        });
        clearFollowupQueueForTest(key);
      }
    },
  );
});
