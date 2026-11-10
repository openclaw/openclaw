// Regression coverage for #193159: an incomplete ask_user answer that arrives
// as a channel turn with a session-controller source (every real channel turn
// since #175837) is finished as "consumed" without adoption, which abandons the
// inbound turn. Telegram's turnAdoptionLifecycle.onAbandoned aborts the turn
// and requeues the update, so the "The answer was not accepted" notice is
// dropped as reply_operation_aborted and the rejected text replays into the
// next message.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentQuestionDispatcher } from "../../agents/harness/gateway-question-dispatch.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import {
  createAgentQuestionAnswerAuthority,
  withAgentQuestionAnswerAuthority,
} from "../../agents/harness/host-private-capabilities.js";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import { EmbeddedQuestionBroker } from "../../infra/embedded-question-broker.js";
import { testing as controllerTesting } from "../../sessions/session-controller.test-support.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import { runReplyQuestionInput } from "./agent-runner-question-input.js";
import {
  createDispatcher,
  diagnosticMocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticDirectReplyConfig,
  createReplyOperation,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import {
  resolveReplyOperationRunState,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { bindReplySourceToFollowup } from "./reply-source-binding.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

type Lifecycle = "telegram" | "chat-send";

function setup(name: string, options: { bindSource: boolean }) {
  const key = `agent:main:discord:direct:question-${name}`;
  const sessionId = `question-${name}`;
  sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
  // The run that called ask_user and is still waiting for the answer.
  const operation = createReplyOperation({ sessionKey: key, sessionId, resetTriggered: false });
  operation.attachBackend({ kind: "cli", runId: "independent-question-run", cancel: vi.fn() });
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
  const sourceBound: boolean[] = [];
  let lastRunState: ReplyOperationRunState | undefined;
  // Mirrors agent-runner-run.ts: bindReplySourceToFollowup(opts, followupRun)
  // runs before runReplyQuestionInput(params).
  const resolveAnswer = vi.fn(async (sessionCtx: MsgContext, opts?: GetReplyOptions) => {
    const text = sessionCtx.BodyForAgent;
    if (typeof text !== "string") {
      throw new Error("missing question answer text");
    }
    const followupRun = createQueueTestRun({ prompt: text, messageId: sessionCtx.MessageSid });
    followupRun.run.sessionKey = key;
    followupRun.turnAdoptionLifecycle = opts?.turnAdoptionLifecycle;
    if (options.bindSource) {
      sourceBound.push(bindReplySourceToFollowup(opts, followupRun) !== undefined);
    }
    lastRunState = resolveReplyOperationRunState(opts);
    const result = await runReplyQuestionInput({
      commandBody: text,
      followupRun,
      sessionKey: key,
      sessionCtx,
      opts,
    });
    return result.handled ? result.payload : undefined;
  });
  const dispatcher = createDispatcher();
  const broker = new EmbeddedQuestionBroker(createTestGatewayScheduler());
  const questionId = `ask_${name}`;
  const questions = [
    { id: "destination", header: "Where", question: "Where to?" },
    { id: "budget", header: "Budget", question: "How much?" },
  ];
  broker.request({
    id: questionId,
    sessionKey: key,
    questions: questions.map(({ id, ...question }) => ({
      ...question,
      questionId: id,
      options: [],
    })),
  });
  const answer = broker.waitAnswer({ id: questionId, includeResolutionId: true });
  const gatewayCall: AgentQuestionDispatcher = {
    version: 2,
    call: async ({ method, params, authority }) => {
      if (authority.kind === "source-bound") {
        authority.assertCurrent();
      }
      return broker.call(method, params);
    },
  };
  const authority = createAgentQuestionAnswerAuthority({
    sessionKey: key,
    fingerprint: "question-rejection-source-repro",
    project: () => "question-rejection-source-repro",
    assertActive: () => {},
  });
  const question = withAgentQuestionAnswerAuthority(authority, () =>
    registerPendingAgentQuestion({ sessionKey: key, questionId, questions, gatewayCall, answer }),
  );
  question.attachRegistration(Promise.resolve());

  return {
    broker,
    questionId,
    dispatcher,
    sourceBound,
    lastRunState: () => lastRunState,
    async answerIncompletely(lifecycle: Lifecycle) {
      const turnAbort = new AbortController();
      const onAbandoned = vi.fn(() => {
        if (lifecycle === "telegram") {
          // extensions/telegram/src/bot-message.ts onAbandoned settles the
          // spooled-replay participant as failed-retryable("turn-abandoned"),
          // which aborts this turn's abortSignal and releases the update for retry.
          turnAbort.abort(new Error("turn-abandoned"));
        }
        // src/gateway/server-methods/chat-send-turn-adoption.ts onAbandoned: no abort.
      });
      const result = await dispatchReplyFromConfig({
        ctx: { ...ctx, agentText: "Lisbon", MessageSid: `incomplete-${name}` },
        cfg: { ...automaticDirectReplyConfig, diagnostics: { enabled: true } },
        dispatcher,
        replyOptions: {
          ...(lifecycle === "telegram" ? { abortSignal: turnAbort.signal } : {}),
          turnAdoptionLifecycle: {
            ...(lifecycle === "telegram" ? { abortSignal: turnAbort.signal } : {}),
            onAdopted: async () => {},
            onAbandoned,
            onSettled: () => {},
          },
        },
        replyResolver: resolveAnswer,
      });
      return { result, onAbandoned };
    },
    dispose() {
      question.dispose();
      broker.stop();
      operation.complete();
    },
  };
}

function processedOutcomes() {
  return diagnosticMocks.logMessageProcessed.mock.calls.map(([params]) => {
    const { outcome, reason } = params as { outcome?: string; reason?: string };
    return `${outcome}:${reason ?? ""}`;
  });
}

describe("incomplete ask_user answer arriving as a channel turn with a session-controller source", () => {
  beforeEach(() => {
    describe0BeforeEach0();
    setNoAbort();
  });
  afterEach(() => {
    controllerTesting.resetSessionControllerForTest();
    resetInboundDedupe();
    clearAgentHarnesses();
  });

  it("control (#146646 shape, no session-controller source): the notice is delivered", async () => {
    const fixture = setup("control-no-source", { bindSource: false });
    try {
      const { onAbandoned } = await fixture.answerIncompletely("telegram");
      expect(fixture.dispatcher.sendFinalReply).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("The answer was not accepted: question 'budget'"),
        }),
      );
      expect(onAbandoned).not.toHaveBeenCalled();
      expect(processedOutcomes()).toContain("error:question-response-rejected");
      expect(fixture.broker.get({ id: fixture.questionId }).question.status).toBe("pending");
    } finally {
      fixture.dispose();
    }
  });

  it.each<Lifecycle>(["telegram", "chat-send"])(
    "%s lifecycle: delivers the rejection notice and does not abandon the inbound turn",
    async (lifecycle) => {
      const fixture = setup(`bound-${lifecycle}`, { bindSource: true });
      try {
        const { onAbandoned } = await fixture.answerIncompletely(lifecycle);
        // Precondition: the turn really carried its session-controller source, as in production.
        expect(fixture.sourceBound).toEqual([true]);
        // The question itself is correctly kept open (validation precedes commitment).
        expect(fixture.broker.get({ id: fixture.questionId }).question.status).toBe("pending");
        expect(
          onAbandoned,
          "a rejected answer must not abandon (and requeue) the inbound turn",
        ).not.toHaveBeenCalled();
        expect(
          fixture.dispatcher.sendFinalReply,
          "the rejection notice must be delivered",
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            text: expect.stringContaining("The answer was not accepted: question 'budget'"),
          }),
        );
        expect(processedOutcomes()).toContain("error:question-response-rejected");
      } finally {
        fixture.dispose();
      }
    },
  );
});
