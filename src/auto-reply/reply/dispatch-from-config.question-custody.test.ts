import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import { expectPendingQuestionAnswerClaimable } from "../../agents/harness/gateway-question-claim.test-support.js";
import type { AgentQuestionDispatcher } from "../../agents/harness/gateway-question-dispatch.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import {
  createAgentQuestionAnswerAuthority,
  withAgentQuestionAnswerAuthority,
} from "../../agents/harness/host-private-capabilities.js";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import { EmbeddedQuestionBroker } from "../../infra/embedded-question-broker.js";
import { testing as controllerTesting } from "../../sessions/session-controller.test-support.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { runReplyQuestionInput } from "./agent-runner-question-input.js";
import {
  createDispatcher,
  diagnosticMocks,
  emptyConfig,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticDirectReplyConfig,
  automaticGroupReplyConfig,
  createReplyOperation,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  firstToolResultPayload,
  requireToolResultHandler,
  setNoAbort,
  getSessionControllerOperation,
} from "./dispatch-from-config.test-support.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { admitFollowupRunLifecycle, completeFollowupRunLifecycle } from "./queue/lifecycle.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { bindReplySourceToFollowup } from "./reply-source-binding.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
});
afterEach(() => {
  controllerTesting.resetSessionControllerForTest();
  resetInboundDedupe();
  clearAgentHarnesses();
});
it("delivers deterministic exec approval tool payloads in groups with progress suppression", async () => {
  const dispatcher = createDispatcher();
  const payload = {
    text: "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
    channelData: {
      execApproval: {
        approvalId: "117ba06d-1111-2222-3333-444444444444",
        approvalSlug: "117ba06d",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    },
  } satisfies ReplyPayload;
  const expected = structuredClone(payload);
  await dispatchReplyFromConfig({
    ctx: buildTestCtx({ Provider: "telegram", ChatType: "group" }),
    cfg: automaticGroupReplyConfig,
    dispatcher,
    replyResolver: async (_ctx, opts) => {
      await opts?.onToolResult?.(payload);
      const runState = resolveReplyOperationRunState(opts);
      if (!runState) {
        throw new Error("expected reply operation run state");
      }
      runState.replyCompletion = resolveReplyCompletion(
        runState.replyCompletion?.expectation ?? "required",
        "blocked",
      );
      return {} satisfies ReplyPayload;
    },
    replyOptions: { suppressDefaultToolProgressMessages: true },
  });

  expect(dispatcher.sendToolResult).toHaveBeenCalledExactlyOnceWith(expected);
  expect(firstToolResultPayload(dispatcher)?.channelData).toStrictEqual(expected.channelData);
  expect(await dispatcher.waitForIdle()).toMatchObject({
    counts: { tool: { delivered: 1 }, final: { delivered: 0 } },
  });
});
it("delivers approval-unavailable notices when verbose tool progress is disabled", async () => {
  const payload = {
    text: "Exec approval is unavailable.",
    channelData: {
      execApprovalUnavailable: { reason: "no-approval-route" },
    },
  } satisfies ReplyPayload;
  const finalReply = { text: "The command could not run without an approval route." };
  const dispatcher = createDispatcher();
  await dispatchReplyFromConfig({
    ctx: buildTestCtx({ Provider: "telegram", ChatType: "direct" }),
    cfg: emptyConfig,
    dispatcher,
    replyResolver: async (_ctx, opts) => {
      await requireToolResultHandler(opts?.onToolResult)(payload);
      return finalReply;
    },
  });

  expect(dispatcher.sendToolResult).toHaveBeenCalledWith(payload);
  expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith(finalReply);
});

function createQuestionDispatch(name: string) {
  const key = `agent:main:discord:direct:question-${name}`;
  const sessionId = `question-${name}`;
  sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
  const operation = createReplyOperation({ sessionKey: key, sessionId, resetTriggered: false });
  const cancel = vi.fn();
  operation.attachBackend({ kind: "cli", runId: "independent-question-run", cancel });
  operation.setPhase("running");
  const ctx = buildTestCtx({
    Provider: "discord",
    Surface: "discord",
    ChatType: "direct",
    From: "user:question-fixture",
    To: "channel:question-fixture",
    SessionKey: key,
    MessageSid: `question-answer-${name}`,
    BodyForAgent: "answer",
  });
  const resolveAnswer = vi.fn(async (sessionCtx: MsgContext, opts?: GetReplyOptions) => {
    const text = sessionCtx.BodyForAgent;
    if (typeof text !== "string") {
      throw new Error("missing question answer text");
    }
    const result = await runReplyQuestionInput({
      commandBody: text,
      followupRun: createQueueTestRun({ prompt: text }),
      sessionKey: key,
      sessionCtx,
      opts,
    });
    expect(result.handled).toBe(true);
    return result.handled ? result.payload : undefined;
  });
  const dispatcher = createDispatcher();
  return {
    operation,
    cancel,
    ctx,
    dispatcher,
    resolveAnswer,
    expectActive() {
      expect(cancel).not.toHaveBeenCalled();
      expect(operation.result).toBeNull();
      expect(getSessionControllerOperation(key)).toBe(operation);
    },
    expectError(text: string, reason: string) {
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining(text), isError: true }),
      );
      expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "error", reason }),
      );
    },
    dispatch(overrides: Partial<DispatchFromConfigParams> = {}) {
      return dispatchReplyFromConfig({
        ctx,
        cfg: { ...automaticDirectReplyConfig, diagnostics: { enabled: true } },
        dispatcher,
        replyOptions: { turnAdoptionLifecycle: { onAdopted: async () => {} } },
        replyResolver: resolveAnswer,
        ...overrides,
      });
    },
    register(params: Omit<Parameters<typeof registerPendingAgentQuestion>[0], "sessionKey">) {
      const authority = createAgentQuestionAnswerAuthority({
        sessionKey: key,
        fingerprint: "question-custody-fixture",
        project: () => "question-custody-fixture",
        assertActive: () => {},
      });
      const question = withAgentQuestionAnswerAuthority(authority, () =>
        registerPendingAgentQuestion({ sessionKey: key, ...params }),
      );
      question.attachRegistration(Promise.resolve());
      return question;
    },
  };
}

describe("dispatch input custody after a question response", () => {
  // Real question/receipt classification is covered by the wire regression. Here
  // the real dispatch owner must preserve that recorded fact through source faults.
  it.each([
    { outcome: "confirmed", failure: "settlement-error" },
    { outcome: "indeterminate", failure: "source-abort" },
  ])("does not replay $outcome input after $failure", async ({ outcome, failure }) => {
    const fixture = createQuestionDispatch(`${outcome}-${failure}`);
    const abort = new AbortController();
    const cleanupError = new Error("source settlement failed");
    const onAdopted = vi.fn(async () => {
      throw new Error("source adoption closed");
    });
    const onSettled = vi.fn(async () => {
      if (failure === "source-abort") {
        abort.abort();
      } else {
        throw cleanupError;
      }
    });
    const resolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const state = resolveReplyOperationRunState(opts);
      if (!state) {
        throw new Error("missing dispatch run state");
      }
      state.admission =
        outcome === "confirmed"
          ? { status: "accepted", mode: "steer" }
          : { status: "skipped", reason: "question-response-indeterminate" };
      const input = createQueueTestRun({ prompt: "answer", messageId: fixture.ctx.MessageSid });
      input.run.sessionKey = fixture.ctx.SessionKey;
      input.turnAdoptionLifecycle = opts?.turnAdoptionLifecycle;
      const source = bindReplySourceToFollowup(opts, input);
      if (!source) {
        throw new Error("Dispatch did not carry its source input");
      }
      await admitFollowupRunLifecycle(input).catch(() => {});
      completeFollowupRunLifecycle(input, "consumed");
      // The full source receipt also owns this still-running resolver. Join
      // the adapter cleanup here, not the enclosing invocation itself.
      await source.custody.settling;
      return undefined;
    });
    try {
      const first = fixture.dispatch({
        cfg: automaticDirectReplyConfig,
        dispatcher: createDispatcher(),
        replyOptions: {
          abortSignal: abort.signal,
          turnAdoptionLifecycle: { onAdopted, onSettled },
        },
        replyResolver: resolver,
      });
      if (failure === "settlement-error") {
        await expect(first).rejects.toBe(cleanupError);
      } else {
        await expect(first).resolves.toMatchObject({ queuedFinal: false });
      }
      const replay = vi.fn(async () => ({ text: "must not replay" }));
      await fixture.dispatch({
        cfg: automaticDirectReplyConfig,
        replyResolver: replay,
      });
      expect(replay).not.toHaveBeenCalled();
      expect(onAdopted).toHaveBeenCalledOnce();
      expect(onSettled).toHaveBeenCalledOnce();
      fixture.expectActive();
    } finally {
      fixture.operation.complete();
    }
  });

  it("delivers a host question refusal when the agent owns normal replies", async () => {
    const fixture = createQuestionDispatch("host-refusal");
    const question = registerPendingAgentQuestion({
      sessionKey: fixture.operation.key,
      questionId: "ask_unbound_source",
      questions: [{ id: "answer", header: "Answer", question: "Continue?" }],
      answer: Promise.resolve({ status: "pending" }),
    });
    question.attachRegistration(Promise.resolve());
    try {
      await fixture.dispatch({
        replyOptions: {
          sourceReplyDeliveryMode: "message_tool_only",
          turnAdoptionLifecycle: { onAdopted: async () => {} },
        },
        replyResolver: (ctx, opts) => {
          const state = resolveReplyOperationRunState(opts);
          if (!state) {
            throw new Error("missing dispatch run state");
          }
          state.preRunRejection = "session-directive-rejected";
          return fixture.resolveAnswer(ctx, opts);
        },
      });
      fixture.expectError("The answer was not sent", "question-response-refused");
      expect(fixture.cancel).not.toHaveBeenCalled();
    } finally {
      question.dispose();
      fixture.operation.complete();
    }
  });

  it("reports an incomplete multi-question answer and keeps the question open", async () => {
    const fixture = createQuestionDispatch("incomplete-answer");
    const { dispatcher, resolveAnswer: replyResolver } = fixture;
    const onResolved = vi.fn();
    const broker = new EmbeddedQuestionBroker(createTestGatewayScheduler(), (event) => {
      if (event.event === "question.resolved") {
        onResolved(event.payload);
      }
    });
    const questionId = "ask_incomplete_answer";
    const questions = [
      { id: "destination", header: "Where", question: "Where to?" },
      { id: "budget", header: "Budget", question: "How much?" },
    ];
    broker.request({
      id: questionId,
      sessionKey: fixture.operation.key,
      questions: questions.map(({ id, ...question }) => ({
        ...question,
        questionId: id,
        options: [],
      })),
    });
    const onResumed = vi.fn();
    const answer = broker.waitAnswer({ id: questionId, includeResolutionId: true });
    const resumed = answer.then(onResumed);
    const gatewayCall: AgentQuestionDispatcher = {
      version: 2,
      call: async ({ method, params, authority }) => {
        if (authority.kind === "source-bound") {
          authority.assertCurrent();
        }
        return broker.call(method, params);
      },
    };
    const question = fixture.register({ questionId, questions, gatewayCall, answer });
    const dispatch = (text: string, messageId: string) =>
      fixture.dispatch({
        ctx: { ...fixture.ctx, agentText: text, MessageSid: messageId },
        replyOptions: {
          sourceReplyDeliveryMode: "message_tool_only",
          turnAdoptionLifecycle: { onAdopted: async () => {} },
        },
      });
    try {
      await dispatch("Lisbon", "incomplete-answer");
      expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
      fixture.expectError(
        "The answer was not accepted: question 'budget'",
        "question-response-rejected",
      );
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("still open") }),
      );
      await expectPendingQuestionAnswerClaimable(fixture.operation.key, true);
      expect(broker.get({ id: questionId }).question).toMatchObject({ status: "pending" });
      expect(broker.get({ id: questionId }).question.answers).toBeUndefined();
      expect(onResolved).not.toHaveBeenCalled();
      expect(onResumed).not.toHaveBeenCalled();
      expect(fixture.cancel).not.toHaveBeenCalled();

      await dispatch("Lisbon", "incomplete-answer");
      expect(replyResolver).toHaveBeenCalledOnce();
      expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
      expect(onResolved).not.toHaveBeenCalled();

      await dispatch("1: Lisbon\n2: 2000", "complete-answer");
      expect(broker.get({ id: questionId }).question).toMatchObject({
        status: "answered",
        answers: { answers: { destination: ["Lisbon"], budget: ["2000"] } },
      });
      await resumed;
      expect(onResolved).toHaveBeenCalledExactlyOnceWith({
        id: questionId,
        status: "answered",
        answers: { answers: { destination: ["Lisbon"], budget: ["2000"] } },
      });
      expect(onResumed).toHaveBeenCalledOnce();
      expect(replyResolver).toHaveBeenCalledTimes(2);
      expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();

      await dispatch("1: Lisbon\n2: 2000", "complete-answer");
      expect(replyResolver).toHaveBeenCalledTimes(2);
      expect(onResolved).toHaveBeenCalledOnce();
      expect(onResumed).toHaveBeenCalledOnce();
      expect(fixture.cancel).not.toHaveBeenCalled();
    } finally {
      question.dispose();
      broker.stop();
      await resumed;
      fixture.operation.complete();
    }
  });

  it.each([
    { code: "INVALID_REQUEST", reason: "QUESTION_ID_IN_USE" },
    { code: "UNAVAILABLE", reason: "QUESTION_INVALID_ANSWER" },
  ])("does not report $code/$reason as an invalid answer", async ({ code, reason }) => {
    const fixture = createQuestionDispatch(`rejection-${code}-${reason}`);
    const { dispatcher } = fixture;
    const error = new GatewayClientRequestError({
      code,
      message: "question request failed",
      details: { reason },
    });
    const question = fixture.register({
      questionId: "ask_rejection_control",
      questions: [{ id: "answer", header: "Answer", question: "Continue?" }],
      answer: Promise.resolve({ status: "pending" }),
      gatewayCall: {
        version: 2,
        call: async () => {
          throw error;
        },
      },
    });
    try {
      const result = fixture.dispatch();
      if (code === "UNAVAILABLE") {
        await expect(result).resolves.toMatchObject({
          queuedFinal: true,
        });
        await expectPendingQuestionAnswerClaimable(fixture.operation.key, false);
        expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
        fixture.expectError("confirmation was lost", "question-response-indeterminate");
      } else {
        await expect(result).rejects.toBe(error);
        await expectPendingQuestionAnswerClaimable(fixture.operation.key, true);
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
        expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "error", error: String(error) }),
        );
      }
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("The answer was not accepted") }),
      );
      expect(diagnosticMocks.logMessageProcessed).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: "question-response-rejected" }),
      );
      fixture.expectActive();
    } finally {
      question.dispose();
      fixture.operation.complete();
    }
  });

  it("still permits retry when the source failed before any input custody transfer", async () => {
    const fixture = createQuestionDispatch("before-custody");
    const error = new Error("failure before input dispatch");
    try {
      await expect(
        fixture.dispatch({
          cfg: automaticDirectReplyConfig,
          dispatcher: createDispatcher(),
          replyResolver: async () => {
            throw error;
          },
        }),
      ).rejects.toBe(error);
      const retry = vi.fn(async () => ({ text: "retry is safe" }));
      await fixture.dispatch({
        cfg: automaticDirectReplyConfig,
        dispatcher: createDispatcher(),
        replyResolver: retry,
      });
      expect(retry).toHaveBeenCalledOnce();
      expect(fixture.cancel).not.toHaveBeenCalled();
    } finally {
      fixture.operation.complete();
    }
  });
});
