import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { expectPendingQuestionAnswerClaimable } from "../../agents/harness/gateway-question-claim.test-support.js";
import type { AgentQuestionDispatcher } from "../../agents/harness/gateway-question-dispatch.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import {
  createAgentQuestionAnswerAuthority,
  withAgentQuestionAnswerAuthority,
} from "../../agents/harness/host-private-capabilities.js";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { onDiagnosticEvent, type DiagnosticEventPayload } from "../../infra/diagnostic-events.js";
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
  hookMocks,
  mocks,
  resetPluginTtsAndThreadMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
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
import { createReplyDispatcher } from "./reply-dispatcher.js";
import {
  REPLY_OPERATION_RUN_STATE,
  resolveReplyOperationRunState,
  type ReplyOperationRunState,
  type ReplyPreRunRejectionCode,
} from "./reply-operation-run-state.js";
import { bindReplySourceToFollowup } from "./reply-source-binding.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);
describe("question custody", () => {
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
      const answerQuestion = (text: string, messageId: string) =>
        fixture.dispatch({
          ctx: { ...fixture.ctx, agentText: text, MessageSid: messageId },
          replyOptions: {
            sourceReplyDeliveryMode: "message_tool_only",
            turnAdoptionLifecycle: { onAdopted: async () => {} },
          },
        });
      try {
        await answerQuestion("Lisbon", "incomplete-answer");
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

        await answerQuestion("Lisbon", "incomplete-answer");
        expect(replyResolver).toHaveBeenCalledOnce();
        expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
        expect(onResolved).not.toHaveBeenCalled();

        await answerQuestion("1: Lisbon\n2: 2000", "complete-answer");
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

        await answerQuestion("1: Lisbon\n2: 2000", "complete-answer");
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
});

type Resolver = NonNullable<DispatchFromConfigParams["replyResolver"]>;
const telegramContext = {
  From: "user1",
  To: "telegram:2000",
  Provider: "telegram",
  Surface: "telegram",
  ChatType: "direct",
} as const;

const REJECTED_MODEL = "openai/REJECTED_PRIVATE_TOKEN";
const SESSION_KEY = "agent:main:session";
const cfg: OpenClawConfig = {
  diagnostics: { enabled: true, otel: { enabled: true, traces: true, captureContent: true } },
  messages: { visibleReplies: "automatic" },
};

async function dispatch(
  replyResolver: Resolver,
  overrides: Partial<DispatchFromConfigParams> = {},
) {
  const dispatcher = overrides.dispatcher ?? createDispatcher();
  await dispatchReplyFromConfig({
    ctx: buildTestCtx({ Body: "hello", SessionKey: SESSION_KEY }),
    cfg,
    dispatcher,
    replyResolver,
    ...overrides,
  });
  return dispatcher;
}

async function dispatchReplyFixture(
  body: string,
  messageId: string,
  reply: ReplyPayload,
  rejection?: ReplyPreRunRejectionCode,
) {
  return dispatch(async () => reply, {
    ctx: buildTestCtx({
      Body: body,
      CommandBody: body,
      CommandAuthorized: true,
      ...telegramContext,
      SessionKey: SESSION_KEY,
      MessageSid: messageId,
    }),
    replyOptions: { [REPLY_OPERATION_RUN_STATE]: { preRunRejection: rejection } },
  });
}

describe("dispatchReplyFromConfig pre-run directive rejection", () => {
  let processedEvents: Extract<DiagnosticEventPayload, { type: "message.processed" }>[];
  let unsubscribe: () => void;

  beforeEach(() => {
    clearAgentHarnesses();
    controllerTesting.resetSessionControllerForTest();
    setDiscordTestRegistry();
    resetInboundDedupe();
    resetPluginTtsAndThreadMocks();
    mocks.routeReply
      .mockReset()
      .mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
    sessionBindingMocks.listBySession.mockReset().mockReturnValue([]);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.loadSessionStoreEntry
      .mockReset()
      .mockImplementation(() => sessionStoreMocks.currentEntry);
    diagnosticMocks.logMessageProcessed.mockClear();
    diagnosticMocks.logMessageDispatchCompleted.mockClear();
    processedEvents = [];
    unsubscribe = onDiagnosticEvent((event) => {
      if (event.type === "message.processed") {
        processedEvents.push(event);
      }
    });
    diagnosticMocks.forwardToRealPipeline = true;
  });

  afterEach(() => {
    unsubscribe();
    diagnosticMocks.forwardToRealPipeline = false;
    hookMocks.runner.hasHooks.mockReset().mockReturnValue(false);
    hookMocks.runner.runBeforeDispatch.mockReset().mockResolvedValue(undefined);
  });

  it("completes a handled before_dispatch turn without waiting for queued delivery", async () => {
    hookMocks.runner.hasHooks.mockImplementation((hookName) => hookName === "before_dispatch");
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({
      handled: true,
      text: "handled by hook",
    });
    const deliveryGate = createDeferred();
    const dispatcher = createReplyDispatcher({ deliver: () => deliveryGate.promise });
    try {
      const pending = dispatch(async () => undefined, {
        ctx: buildTestCtx({
          Body: "hello",
          ...telegramContext,
          SessionKey: SESSION_KEY,
          MessageSid: "handled-1",
        }),
        dispatcher,
      });
      // Capture must never hold completion open for a pending delivery: the gate
      // stays closed until finally, so a regression never settles and times out.
      await pending;
      expect(processedEvents).toEqual([
        expect.objectContaining({ outcome: "completed", reason: "before_dispatch_handled" }),
      ]);
      // A hook-authored reply is not model output.
      expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
        expect.not.objectContaining({ finalResponse: expect.anything() }),
      );
    } finally {
      deliveryGate.resolve();
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
    }
  });

  it("emits one safe skipped event without changing the reply or the next turn", async () => {
    const reason = "session-directive-rejected";
    const reply = { text: `Model "${REJECTED_MODEL}" is not allowed.`, isError: true };
    const dispatcher = await dispatchReplyFixture(
      `/model ${REJECTED_MODEL} -s`,
      "1",
      reply,
      reason,
    );

    expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith(reply);
    expect(processedEvents).toEqual([
      expect.objectContaining({
        type: "message.processed",
        agentId: "main",
        channel: "telegram",
        sessionKey: SESSION_KEY,
        messageId: "1",
        outcome: "skipped",
        reason,
      }),
    ]);
    expect(processedEvents[0]?.error).toBeUndefined();
    expect(JSON.stringify(processedEvents)).not.toContain(REJECTED_MODEL);
    for (const diagnostic of [
      diagnosticMocks.logMessageProcessed,
      diagnosticMocks.logMessageDispatchCompleted,
    ]) {
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ outcome: "skipped", reason }),
      );
      expect(diagnostic.mock.calls[0]?.[0].error).toBeUndefined();
    }
    const nextReply = { text: "Agent reply." };
    const nextDispatcher = await dispatchReplyFixture("hello again", "2", nextReply);

    expect(nextDispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith(nextReply);
    expect(processedEvents).toMatchObject([
      { messageId: "1", outcome: "skipped", reason: "session-directive-rejected" },
      { messageId: "2", outcome: "completed" },
    ]);
    expect(processedEvents[1]?.reason).toBeUndefined();
  });

  it.each<[string, ReplyPayload[] | undefined, string?, boolean?]>([
    [
      "delivered reply",
      [{ text: "internal reasoning trace", isReasoning: true }, { text: "Agent reply." }],
    ],
    ["sentinel", undefined, "NO_REPLY"],
    ["delivery failure", undefined, "model answer", true],
  ])("captures only model output for %s", async (_label, replies, raw, failed) => {
    const pending = dispatch(async (_ctx, options) => {
      if (raw !== undefined) {
        options?.onRawLlmResponse?.(raw);
      }
      if (failed) {
        throw new Error("final delivery failed");
      }
      return replies;
    });
    if (failed) {
      await pending.catch(() => undefined);
    } else {
      await pending;
    }
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      raw === undefined
        ? expect.not.objectContaining({ finalResponse: expect.anything() })
        : expect.objectContaining({ finalResponse: raw, ...(failed ? { outcome: "error" } : {}) }),
    );
  });

  it.each<[string, ReplyOperationRunState, boolean, string, string?]>([
    ["agent failure", {}, true, "error"],
    [
      "queue cap",
      { admission: { status: "skipped", reason: "queue-cap" } },
      false,
      "skipped",
      "queue-cap",
    ],
    [
      "injection abort",
      { messageInjectionAborted: true },
      false,
      "skipped",
      "reply_operation_aborted",
    ],
  ])(
    "preserves the terminal %s over a rejection fact",
    async (_label, state, failed, outcome, reason) => {
      const runState: ReplyOperationRunState = {
        ...state,
        preRunRejection: "session-directive-rejected",
      };
      await dispatch(
        async (_ctx, opts) => {
          // Queue and question owners publish their decisions after outer operation admission.
          Object.assign(runState, state);
          if (failed) {
            opts?.onAgentRunTerminalOutcome?.("failed");
          }
          return { text: "Existing terminal reply." };
        },
        { replyOptions: { [REPLY_OPERATION_RUN_STATE]: runState } },
      );

      expect(processedEvents).toMatchObject([{ outcome }]);
      expect(processedEvents[0]?.reason).toBe(reason);
      expect(processedEvents[0]?.error).toBeUndefined();
    },
  );
});
