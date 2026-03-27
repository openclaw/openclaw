import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import type { FollowupRun } from "./queue.js";
import type { TypingSignaler } from "./typing-mode.js";

const state = vi.hoisted(() => ({
  runEmbeddedPiAgentMock: vi.fn(),
  runWithModelFallbackMock: vi.fn(),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => state.runEmbeddedPiAgentMock(params),
}));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: unknown) => state.runWithModelFallbackMock(params),
}));

vi.mock("../../agents/model-selection.js", () => ({
  isCliProvider: () => false,
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: vi.fn(),
}));

vi.mock("../../agents/cli-session.js", () => ({
  getCliSessionId: vi.fn(),
}));

vi.mock("../../agents/bootstrap-budget.js", () => ({
  resolveBootstrapWarningSignaturesSeen: () => [],
}));

vi.mock("../../agents/pi-embedded-helpers.js", () => ({
  BILLING_ERROR_USER_MESSAGE: "billing",
  isCompactionFailureError: () => false,
  isContextOverflowError: () => false,
  isBillingErrorMessage: () => false,
  isLikelyContextOverflowError: () => false,
  isTransientHttpError: () => false,
  sanitizeUserFacingText: (text?: string) => text ?? "",
}));

vi.mock("../../config/sessions.js", () => ({
  resolveGroupSessionKey: vi.fn(() => null),
  resolveSessionTranscriptPath: vi.fn(),
  updateSessionStore: vi.fn(),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
  registerAgentRunContext: vi.fn(),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
  },
}));

vi.mock("../../utils/message-channel.js", () => ({
  isMarkdownCapableMessageChannel: () => true,
  resolveMessageChannel: () => "whatsapp",
  isInternalMessageChannel: () => false,
}));

vi.mock("../heartbeat.js", () => ({
  stripHeartbeatToken: (text: string) => ({
    text,
    didStrip: false,
    shouldSkip: false,
  }),
}));

vi.mock("./agent-runner-utils.js", () => ({
  buildEmbeddedRunExecutionParams: () => ({
    embeddedContext: {},
    senderContext: {},
    runBaseParams: {},
  }),
  resolveModelFallbackOptions: vi.fn(() => ({})),
}));

vi.mock("./reply-delivery.js", () => ({
  createBlockReplyDeliveryHandler: vi.fn(),
}));

vi.mock("./reply-media-paths.runtime.js", () => ({
  createReplyMediaPathNormalizer: () => (payload: unknown) => payload,
}));

async function getRunAgentTurnWithFallback() {
  return (await import("./agent-runner-execution.js")).runAgentTurnWithFallback;
}

type FallbackRunnerParams = {
  run: (provider: string, model: string) => Promise<unknown>;
};

type EmbeddedAgentParams = {
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
};

function createMockTypingSignaler(): TypingSignaler {
  return {
    mode: "message",
    shouldStartImmediately: false,
    shouldStartOnMessageStart: true,
    shouldStartOnText: true,
    shouldStartOnReasoning: false,
    signalRunStart: vi.fn(async () => {}),
    signalMessageStart: vi.fn(async () => {}),
    signalTextDelta: vi.fn(async () => {}),
    signalReasoningDelta: vi.fn(async () => {}),
    signalToolStart: vi.fn(async () => {}),
  };
}

function createFollowupRun(): FollowupRun {
  return {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;
}

describe("runAgentTurnWithFallback", () => {
  beforeEach(() => {
    state.runEmbeddedPiAgentMock.mockReset();
    state.runWithModelFallbackMock.mockReset();
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => ({
      result: await params.run("anthropic", "claude"),
      provider: "anthropic",
      model: "claude",
      attempts: [],
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards media-only tool results without typing text", async () => {
    const onToolResult = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onToolResult?.({ mediaUrls: ["/tmp/generated.png"] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    const typingSignals = createMockTypingSignaler();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {
        onToolResult,
      } satisfies GetReplyOptions,
      typingSignals,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks,
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    await Promise.all(pendingToolTasks);

    expect(result.kind).toBe("success");
    expect(typingSignals.signalTextDelta).not.toHaveBeenCalled();
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onToolResult.mock.calls[0]?.[0]).toMatchObject({
      mediaUrls: ["/tmp/generated.png"],
    });
    expect(onToolResult.mock.calls[0]?.[0]?.text).toBeUndefined();
  });
});
