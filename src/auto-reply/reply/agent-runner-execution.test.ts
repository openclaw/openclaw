import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import { MAX_LIVE_SWITCH_RETRIES } from "./agent-runner-execution.js";
import type { FollowupRun } from "./queue.js";
import type { TypingSignaler } from "./typing-mode.js";

const state = vi.hoisted(() => ({
  runEmbeddedPiAgentMock: vi.fn(),
  runWithModelFallbackMock: vi.fn(),
  isInternalMessageChannelMock: vi.fn((_: unknown) => false),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => state.runEmbeddedPiAgentMock(params),
}));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: unknown) => state.runWithModelFallbackMock(params),
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
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
  isRateLimitErrorMessage: () => false,
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
  isInternalMessageChannel: (value: unknown) => state.isInternalMessageChannelMock(value),
}));

vi.mock("../heartbeat.js", () => ({
  stripHeartbeatToken: (text: string) => ({
    text,
    didStrip: false,
    shouldSkip: false,
  }),
}));

vi.mock("./agent-runner-utils.js", () => ({
  buildEmbeddedRunExecutionParams: (params: { provider: string; model: string }) => ({
    embeddedContext: {},
    senderContext: {},
    runBaseParams: {
      provider: params.provider,
      model: params.model,
    },
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
  onItemEvent?: (payload: {
    itemId?: string;
    kind?: string;
    title?: string;
    name?: string;
    phase?: string;
    status?: string;
    summary?: string;
    progressText?: string;
    approvalId?: string;
    approvalSlug?: string;
  }) => Promise<void> | void;
  onAgentEvent?: (payload: {
    stream: string;
    data: Record<string, unknown>;
  }) => Promise<void> | void;
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
    state.isInternalMessageChannelMock.mockReset();
    state.isInternalMessageChannelMock.mockReturnValue(false);
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

  it("forwards item lifecycle events to reply options", async () => {
    const onItemEvent = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "item",
        data: {
          itemId: "tool:read-1",
          kind: "tool",
          title: "read",
          name: "read",
          phase: "start",
          status: "running",
        },
      });
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
        onItemEvent,
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
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "tool:read-1",
      kind: "tool",
      title: "read",
      name: "read",
      phase: "start",
      status: "running",
    });
  });

  it("forwards plan, approval, command output, and patch events", async () => {
    const onPlanUpdate = vi.fn();
    const onApprovalEvent = vi.fn();
    const onCommandOutput = vi.fn();
    const onPatchSummary = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "plan",
        data: {
          phase: "update",
          title: "Assistant proposed a plan",
          explanation: "Inspect code, patch it, run tests.",
          steps: ["Inspect code", "Patch code", "Run tests"],
        },
      });
      await params.onAgentEvent?.({
        stream: "approval",
        data: {
          phase: "requested",
          kind: "exec",
          status: "pending",
          title: "Command approval requested",
          approvalId: "approval-1",
        },
      });
      await params.onAgentEvent?.({
        stream: "command_output",
        data: {
          itemId: "command:exec-1",
          phase: "delta",
          title: "command ls",
          toolCallId: "exec-1",
          output: "README.md",
        },
      });
      await params.onAgentEvent?.({
        stream: "patch",
        data: {
          itemId: "patch:patch-1",
          phase: "end",
          title: "apply patch",
          toolCallId: "patch-1",
          added: ["a.ts"],
          modified: ["b.ts"],
          deleted: [],
          summary: "1 added, 1 modified",
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {
        onPlanUpdate,
        onApprovalEvent,
        onCommandOutput,
        onPatchSummary,
      } satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
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

    expect(onPlanUpdate).toHaveBeenCalledWith({
      phase: "update",
      title: "Assistant proposed a plan",
      explanation: "Inspect code, patch it, run tests.",
      steps: ["Inspect code", "Patch code", "Run tests"],
      source: undefined,
    });
    expect(onApprovalEvent).toHaveBeenCalledWith({
      phase: "requested",
      kind: "exec",
      status: "pending",
      title: "Command approval requested",
      itemId: undefined,
      toolCallId: undefined,
      approvalId: "approval-1",
      approvalSlug: undefined,
      command: undefined,
      host: undefined,
      reason: undefined,
      message: undefined,
    });
    expect(onCommandOutput).toHaveBeenCalledWith({
      itemId: "command:exec-1",
      phase: "delta",
      title: "command ls",
      toolCallId: "exec-1",
      name: undefined,
      output: "README.md",
      status: undefined,
      exitCode: undefined,
      durationMs: undefined,
      cwd: undefined,
    });
    expect(onPatchSummary).toHaveBeenCalledWith({
      itemId: "patch:patch-1",
      phase: "end",
      title: "apply patch",
      toolCallId: "patch-1",
      name: undefined,
      added: ["a.ts"],
      modified: ["b.ts"],
      deleted: [],
      summary: "1 added, 1 modified",
    });
  });

  it("keeps compaction start notices silent by default", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onBlockReply },
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("keeps compaction callbacks active when notices are silent by default", async () => {
    const onBlockReply = vi.fn();
    const onCompactionStart = vi.fn();
    const onCompactionEnd = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      await params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", completed: true },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {
        onBlockReply,
        onCompactionStart,
        onCompactionEnd,
      },
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expect(onCompactionStart).toHaveBeenCalledTimes(1);
    expect(onCompactionEnd).toHaveBeenCalledTimes(1);
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("emits a compaction start notice when notifyUser is enabled", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const followupRun = createFollowupRun();
    followupRun.run.config = {
      agents: {
        defaults: {
          compaction: {
            notifyUser: true,
          },
        },
      },
    };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onBlockReply },
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "🧹 Compacting context...",
        replyToId: "msg",
        replyToCurrent: true,
        isCompactionNotice: true,
      }),
    );
  });

  it("does not show a rate-limit countdown for mixed-cause fallback exhaustion", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "All models failed (2): anthropic/claude: 429 (rate_limit) | openai/gpt-5.4: 402 (billing)",
        ),
        {
          name: "FallbackSummaryError",
          attempts: [
            { provider: "anthropic", model: "claude", error: "429", reason: "rate_limit" },
            { provider: "openai", model: "gpt-5.4", error: "402", reason: "billing" },
          ],
          soonestCooldownExpiry: Date.now() + 60_000,
        },
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("Something went wrong while processing your request");
      expect(result.payload.text).not.toContain("Rate-limited");
    }
  });

  it("returns a friendly generic error on external chat channels", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error("INVALID_ARGUMENT: some other failure"),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.",
      );
    }
  });

  it("returns a session reset hint for Bedrock tool mismatch errors on external chat channels", async () => {
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error(
        "The number of toolResult blocks at messages.186.content exceeds the number of toolUse blocks of previous turn.",
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Session history got out of sync. Please try again, or use /new to start a fresh session.",
      );
    }
  });

  it("keeps raw generic errors on internal control surfaces", async () => {
    state.isInternalMessageChannelMock.mockReturnValue(true);
    state.runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error("INVALID_ARGUMENT: some other failure"),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "chat",
        Surface: "chat",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("Agent failed before reply");
      expect(result.payload.text).toContain("INVALID_ARGUMENT: some other failure");
      expect(result.payload.text).toContain("Logs: openclaw logs --follow");
    }
  });

  it("restarts the active prompt when a live model switch is requested", async () => {
    let fallbackInvocation = 0;
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => ({
        result: await params.run(
          fallbackInvocation === 0 ? "anthropic" : "openai",
          fallbackInvocation === 0 ? "claude" : "gpt-5.4",
        ),
        provider: fallbackInvocation === 0 ? "anthropic" : "openai",
        model: fallbackInvocation++ === 0 ? "claude" : "gpt-5.4",
        attempts: [],
      }),
    );
    state.runEmbeddedPiAgentMock
      .mockImplementationOnce(async () => {
        throw new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.4",
        });
      })
      .mockImplementationOnce(async () => {
        return {
          payloads: [{ text: "switched" }],
          meta: {
            agentMeta: {
              sessionId: "session",
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        };
      });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expect(state.runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(followupRun.run.provider).toBe("openai");
    expect(followupRun.run.model).toBe("gpt-5.4");
  });

  it("breaks out of the retry loop when LiveSessionModelSwitchError is thrown repeatedly (#58348)", async () => {
    // Simulate a scenario where the persisted session selection keeps conflicting
    // with the fallback model, causing LiveSessionModelSwitchError on every attempt.
    // The outer loop must be bounded to prevent a session death loop.
    let switchCallCount = 0;
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        switchCallCount++;
        return {
          result: await params.run("anthropic", "claude"),
          provider: "anthropic",
          model: "claude",
          attempts: [],
        };
      },
    );
    state.runEmbeddedPiAgentMock.mockImplementation(async () => {
      throw new LiveSessionModelSwitchError({
        provider: "openai",
        model: "gpt-5.4",
      });
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    // After MAX_LIVE_SWITCH_RETRIES (2) the loop must break instead of continuing
    // forever. The result should be a final error, not an infinite hang.
    expect(result.kind).toBe("final");
    // 1 initial + MAX_LIVE_SWITCH_RETRIES retries = exact total invocations
    expect(switchCallCount).toBe(1 + MAX_LIVE_SWITCH_RETRIES);
  });

  it("propagates auth profile state on bounded live model switch retries (#58348)", async () => {
    let invocation = 0;
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        invocation++;
        if (invocation <= 2) {
          return {
            result: await params.run("anthropic", "claude"),
            provider: "anthropic",
            model: "claude",
            attempts: [],
          };
        }
        // Third invocation succeeds with the switched model
        return {
          result: await params.run("openai", "gpt-5.4"),
          provider: "openai",
          model: "gpt-5.4",
          attempts: [],
        };
      },
    );
    state.runEmbeddedPiAgentMock
      .mockImplementationOnce(async () => {
        throw new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.4",
          authProfileId: "profile-b",
          authProfileIdSource: "user",
        });
      })
      .mockImplementationOnce(async () => {
        throw new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.4",
          authProfileId: "profile-c",
          authProfileIdSource: "auto",
        });
      })
      .mockImplementationOnce(async () => {
        return {
          payloads: [{ text: "finally ok" }],
          meta: {
            agentMeta: {
              sessionId: "session",
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        };
      });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const followupRun = createFollowupRun();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    // Two switches (within the limit of 2) then success on third attempt
    expect(result.kind).toBe("success");
    expect(state.runEmbeddedPiAgentMock).toHaveBeenCalledTimes(3);
    expect(followupRun.run.provider).toBe("openai");
    expect(followupRun.run.model).toBe("gpt-5.4");
    expect(followupRun.run.authProfileId).toBe("profile-c");
    expect(followupRun.run.authProfileIdSource).toBe("auto");
  });

  it("does not roll back newer override changes after a failed fallback candidate", async () => {
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        await expect(params.run("openai", "gpt-5.4")).rejects.toThrow("fallback failed");
        throw new Error("fallback failed");
      },
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      providerOverride: "anthropic",
      modelOverride: "claude",
      authProfileOverride: "anthropic:default",
      authProfileOverrideSource: "user",
    };
    const sessionStore = { main: sessionEntry };
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
      sessionEntry.providerOverride = "zai";
      sessionEntry.modelOverride = "glm-5";
      sessionEntry.authProfileOverride = "zai:work";
      sessionEntry.authProfileOverrideSource = "user";
      throw new Error("fallback failed");
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => sessionEntry,
      activeSessionStore: sessionStore,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    expect(sessionEntry.providerOverride).toBe("zai");
    expect(sessionEntry.modelOverride).toBe("glm-5");
    expect(sessionEntry.authProfileOverride).toBe("zai:work");
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
    expect(sessionStore.main.providerOverride).toBe("zai");
    expect(sessionStore.main.modelOverride).toBe("glm-5");
  });
});
