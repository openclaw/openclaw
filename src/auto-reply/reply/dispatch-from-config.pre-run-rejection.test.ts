// Tests invocation rejection outcomes through shared dispatch and the diagnostic bus.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { onDiagnosticEvent, type DiagnosticEventPayload } from "../../infra/diagnostic-events.js";
import type { ReplyPayload } from "../types.js";
import {
  createDispatcher,
  diagnosticMocks,
  hookMocks,
  mocks,
  parseGenericThreadSessionInfo,
  resetPluginTtsAndThreadMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
  threadInfoMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
  type ReplyPreRunRejectionCode,
} from "./reply-operation-run-state.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let resetReplyRunRegistry: () => void;

const REJECTED_MODEL = "openai/REJECTED_PRIVATE_TOKEN";
const SESSION_KEY = "agent:main:session";
const cfg: OpenClawConfig = {
  diagnostics: {
    enabled: true,
    otel: { enabled: true, traces: true, captureContent: true },
  },
  messages: { visibleReplies: "automatic" },
};

async function dispatchReplyFixture(params: {
  body: string;
  messageId: string;
  reply: ReplyPayload;
  rejection?: ReplyPreRunRejectionCode;
}) {
  const runState: ReplyOperationRunState = { preRunRejection: params.rejection };
  const dispatcher = createDispatcher();
  await dispatchReplyFromConfig({
    ctx: buildTestCtx({
      Body: params.body,
      CommandBody: params.body,
      CommandAuthorized: true,
      From: "user1",
      To: "telegram:2000",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
      SessionKey: SESSION_KEY,
      MessageSid: params.messageId,
    }),
    cfg,
    dispatcher,
    replyOptions: { [REPLY_OPERATION_RUN_STATE]: runState },
    replyResolver: async () => params.reply,
  });
  return dispatcher;
}

describe("dispatchReplyFromConfig pre-run directive rejection", () => {
  let processedEvents: Extract<DiagnosticEventPayload, { type: "message.processed" }>[];
  let unsubscribe: () => void;

  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
    const { testing } = await import("./reply-run-registry.test-support.js");
    resetReplyRunRegistry = () => testing.resetReplyRunRegistry();
  });

  beforeEach(() => {
    clearAgentHarnesses();
    resetReplyRunRegistry();
    setDiscordTestRegistry();
    resetInboundDedupe();
    resetPluginTtsAndThreadMocks();
    mocks.routeReply
      .mockReset()
      .mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
    threadInfoMocks.parseSessionThreadInfo
      .mockReset()
      .mockImplementation(parseGenericThreadSessionInfo);
    sessionBindingMocks.listBySession.mockReset().mockReturnValue([]);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.loadSessionStoreEntry
      .mockReset()
      .mockImplementation(() => sessionStoreMocks.currentEntry);
    sessionStoreMocks.readSessionEntry
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
      const dispatch = dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Body: "hello",
          From: "user1",
          To: "telegram:2000",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "direct",
          SessionKey: SESSION_KEY,
          MessageSid: "handled-1",
        }),
        cfg,
        dispatcher,
        replyResolver: async () => undefined,
      });
      // Capture must never hold completion open for a pending delivery: the gate
      // stays closed until finally, so a regression never settles and times out.
      await dispatch;
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

  it.each<ReplyPreRunRejectionCode>(["model-selection-rejected"])(
    "emits one safe skipped event for %s without changing the reply",
    async (reason) => {
      const reply = { text: `Model "${REJECTED_MODEL}" is not allowed.`, isError: true };
      const dispatcher = await dispatchReplyFixture({
        body: `/model ${REJECTED_MODEL} -s`,
        messageId: "1",
        reply,
        rejection: reason,
      });

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
        expect(diagnostic).toHaveBeenCalledOnce();
        expect(diagnostic).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "skipped", reason }),
        );
        expect(diagnostic.mock.calls[0]?.[0].error).toBeUndefined();
      }
    },
  );

  it("completes an ordinary turn after a rejection in the same session", async () => {
    await dispatchReplyFixture({
      body: `/model ${REJECTED_MODEL} -s`,
      messageId: "1",
      reply: { text: `Model "${REJECTED_MODEL}" is not allowed.`, isError: true },
      rejection: "session-directive-rejected",
    });
    const reply = { text: "Agent reply." };
    const dispatcher = await dispatchReplyFixture({
      body: "hello again",
      messageId: "2",
      reply,
    });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith(reply);
    expect(
      processedEvents.map(({ messageId, outcome, reason }) => ({ messageId, outcome, reason })),
    ).toEqual([
      { messageId: "1", outcome: "skipped", reason: "session-directive-rejected" },
      { messageId: "2", outcome: "completed", reason: undefined },
    ]);
  });

  it("never captures delivered reply text without a model response", async () => {
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Body: "hello", SessionKey: SESSION_KEY }),
      cfg,
      dispatcher: createDispatcher(),
      replyResolver: async () =>
        [
          { text: "internal reasoning trace", isReasoning: true },
          { text: "Agent reply." },
        ] satisfies ReplyPayload[],
    });

    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.not.objectContaining({ finalResponse: expect.anything() }),
    );
  });

  it("excludes the delivered fallback notice from the captured response for an empty turn", async () => {
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Body: "hello", SessionKey: SESSION_KEY }),
      cfg,
      dispatcher: createDispatcher(),
      replyResolver: async () => undefined,
    });

    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.not.objectContaining({ finalResponse: expect.anything() }),
    );
  });

  it("captures the raw LLM response for a sentinel turn instead of delivered facts", async () => {
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Body: "hello", SessionKey: SESSION_KEY }),
      cfg,
      dispatcher: createDispatcher(),
      replyResolver: async (_ctx, opts) => {
        opts?.onRawLlmResponse?.("NO_REPLY");
        return undefined;
      },
    });

    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ finalResponse: "NO_REPLY" }),
    );
  });

  it("keeps the captured model response when dispatch fails after the model answered", async () => {
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Body: "hello", SessionKey: SESSION_KEY }),
      cfg,
      dispatcher: createDispatcher(),
      replyResolver: async (_ctx, opts) => {
        opts?.onRawLlmResponse?.("model answer");
        throw new Error("final delivery failed");
      },
    }).catch(() => undefined);

    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "error", finalResponse: "model answer" }),
    );
  });

  it("excludes delivered host error notices from the captured response", async () => {
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Body: "hello", SessionKey: SESSION_KEY }),
      cfg,
      dispatcher: createDispatcher(),
      replyResolver: async () => [
        { text: "⚠️ Agent couldn't generate a response. Please try again.", isError: true },
      ],
    });

    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.not.objectContaining({ finalResponse: expect.anything() }),
    );
  });

  it.each<{
    label: string;
    state: ReplyOperationRunState;
    failed?: true;
    outcome: string;
    reason?: string;
  }>([
    { label: "agent failure", state: {}, failed: true, outcome: "error" },
    {
      label: "queue cap",
      state: { admission: { status: "skipped", reason: "queue-cap" } },
      outcome: "skipped",
      reason: "queue-cap",
    },
    {
      label: "injection abort",
      state: { messageInjectionAborted: true },
      outcome: "skipped",
      reason: "reply_operation_aborted",
    },
    {
      label: "question refusal",
      state: { admission: { status: "skipped", reason: "question-response-refused" } },
      outcome: "error",
      reason: "question-response-refused",
    },
  ])(
    "preserves the terminal $label over a rejection fact",
    async ({ state, failed, outcome, reason }) => {
      const runState: ReplyOperationRunState = {
        ...state,
        preRunRejection: "session-directive-rejected",
      };
      await dispatchReplyFromConfig({
        ctx: buildTestCtx({ Body: "hello", SessionKey: SESSION_KEY }),
        cfg,
        dispatcher: createDispatcher(),
        replyOptions: { [REPLY_OPERATION_RUN_STATE]: runState },
        replyResolver: async (_ctx, opts) => {
          // Queue and question owners publish their decisions after outer operation admission.
          Object.assign(runState, state);
          if (failed) {
            opts?.onAgentRunTerminalOutcome?.("failed");
          }
          return { text: "Existing terminal reply." };
        },
      });

      expect(processedEvents).toHaveLength(1);
      expect(processedEvents[0]).toMatchObject({ outcome });
      expect(processedEvents[0]?.reason).toBe(reason);
      expect(processedEvents[0]?.error).toBeUndefined();
    },
  );
});
