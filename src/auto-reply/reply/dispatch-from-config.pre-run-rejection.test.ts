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
  resetPluginTtsAndThreadMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
  type ReplyPreRunRejectionCode,
} from "./reply-operation-run-state.js";
import { buildTestCtx } from "./test-ctx.js";

type Resolver = NonNullable<DispatchFromConfigParams["replyResolver"]>;
const telegramContext = {
  From: "user1",
  To: "telegram:2000",
  Provider: "telegram",
  Surface: "telegram",
  ChatType: "direct",
} as const;

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let resetSessionControllerForTest: () => void;

const REJECTED_MODEL = "openai/REJECTED_PRIVATE_TOKEN";
const SESSION_KEY = "agent:main:session";
const cfg: OpenClawConfig = {
  diagnostics: {
    enabled: true,
    otel: { enabled: true, traces: true, captureContent: true },
  },
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

async function dispatchReplyFixture(params: {
  body: string;
  messageId: string;
  reply: ReplyPayload;
  rejection?: ReplyPreRunRejectionCode;
}) {
  return dispatch(async () => params.reply, {
    ctx: buildTestCtx({
      Body: params.body,
      CommandBody: params.body,
      CommandAuthorized: true,
      ...telegramContext,
      SessionKey: SESSION_KEY,
      MessageSid: params.messageId,
    }),
    replyOptions: { [REPLY_OPERATION_RUN_STATE]: { preRunRejection: params.rejection } },
  });
}

describe("dispatchReplyFromConfig pre-run directive rejection", () => {
  let processedEvents: Extract<DiagnosticEventPayload, { type: "message.processed" }>[];
  let unsubscribe: () => void;

  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
    const { testing } = await import("../../sessions/session-controller.test-support.js");
    resetSessionControllerForTest = () => testing.resetSessionControllerForTest();
  });

  beforeEach(() => {
    clearAgentHarnesses();
    resetSessionControllerForTest();
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

  it.each<ReplyPreRunRejectionCode>(["model-selection-rejected", "session-directive-rejected"])(
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
        expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ outcome: "skipped", reason }),
        );
        expect(diagnostic.mock.calls[0]?.[0].error).toBeUndefined();
      }
      if (reason !== "session-directive-rejected") {
        return;
      }
      const nextReply = { text: "Agent reply." };
      const nextDispatcher = await dispatchReplyFixture({
        body: "hello again",
        messageId: "2",
        reply: nextReply,
      });

      expect(nextDispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith(nextReply);
      expect(processedEvents).toMatchObject([
        { messageId: "1", outcome: "skipped", reason: "session-directive-rejected" },
        { messageId: "2", outcome: "completed" },
      ]);
      expect(processedEvents[1]?.reason).toBeUndefined();
    },
  );

  it.each<[string, ReplyPayload[] | undefined, string?, boolean?]>([
    [
      "delivered reply",
      [{ text: "internal reasoning trace", isReasoning: true }, { text: "Agent reply." }],
    ],
    ["empty-turn fallback", undefined],
    [
      "host error",
      [{ text: "⚠️ Agent couldn't generate a response. Please try again.", isError: true }],
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
    [
      "question refusal",
      { admission: { status: "skipped", reason: "question-response-refused" } },
      false,
      "error",
      "question-response-refused",
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
