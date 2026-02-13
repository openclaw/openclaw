/**
 * Test: after_tool_call hook wiring (pi-embedded-subscribe.handlers.tools.ts)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runAfterToolCall: vi.fn(async () => {}),
  },
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

// Mock agent events (used by handlers)
vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

describe("after_tool_call hook wiring", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runAfterToolCall.mockReset();
    hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);
  });

  it("calls runAfterToolCall in handleToolExecutionEnd when hook is registered", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const { handleToolExecutionEnd, handleToolExecutionStart } =
      await import("../agents/pi-embedded-subscribe.handlers.tools.js");

    const ctx = {
      params: {
        runId: "test-run-1",
        session: { messages: [] },
        agentId: "main",
        sessionKey: "test-session",
        onBlockReplyFlush: undefined,
      },
      state: {
        toolMetaById: new Map<string, string | undefined>(),
        toolMetas: [] as Array<{ toolName?: string; meta?: string }>,
        toolSummaryById: new Set<string>(),
        lastToolError: undefined,
        pendingMessagingTexts: new Map<string, string>(),
        pendingMessagingTargets: new Map<string, unknown>(),
        messagingToolSentTexts: [] as string[],
        messagingToolSentTextsNormalized: [] as string[],
        messagingToolSentTargets: [] as unknown[],
        blockBuffer: "",
      },
      log: { debug: vi.fn(), warn: vi.fn() },
      flushBlockReplyBuffer: vi.fn(),
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
      emitToolSummary: vi.fn(),
      emitToolOutput: vi.fn(),
      trimMessagingToolSent: vi.fn(),
    };

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "call-1",
        args: { path: "/tmp/file.txt" },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "read",
        toolCallId: "call-1",
        isError: false,
        result: { content: [{ type: "text", text: "file contents" }] },
      } as never,
    );

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);

    const [event, context] = hookMocks.runner.runAfterToolCall.mock.calls[0];
    expect(event.toolName).toBe("read");
    expect(event.params).toEqual({ path: "/tmp/file.txt" });
    expect(event.error).toBeUndefined();
    expect(typeof event.durationMs).toBe("number");
    expect(context.toolName).toBe("read");
  });

  it("includes error in after_tool_call event on tool failure", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const { handleToolExecutionEnd, handleToolExecutionStart } =
      await import("../agents/pi-embedded-subscribe.handlers.tools.js");

    const ctx = {
      params: {
        runId: "test-run-2",
        session: { messages: [] },
        onBlockReplyFlush: undefined,
      },
      state: {
        toolMetaById: new Map<string, string | undefined>(),
        toolMetas: [] as Array<{ toolName?: string; meta?: string }>,
        toolSummaryById: new Set<string>(),
        lastToolError: undefined,
        pendingMessagingTexts: new Map<string, string>(),
        pendingMessagingTargets: new Map<string, unknown>(),
        messagingToolSentTexts: [] as string[],
        messagingToolSentTextsNormalized: [] as string[],
        messagingToolSentTargets: [] as unknown[],
        blockBuffer: "",
      },
      log: { debug: vi.fn(), warn: vi.fn() },
      flushBlockReplyBuffer: vi.fn(),
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
      emitToolSummary: vi.fn(),
      emitToolOutput: vi.fn(),
      trimMessagingToolSent: vi.fn(),
    };

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "exec",
        toolCallId: "call-err",
        args: { command: "fail" },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId: "call-err",
        isError: true,
        result: { status: "error", error: "command failed" },
      } as never,
    );

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);

    const [event] = hookMocks.runner.runAfterToolCall.mock.calls[0];
    expect(event.error).toBeDefined();
  });

  it("does not call runAfterToolCall when no hooks registered", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);

    const { handleToolExecutionEnd } =
      await import("../agents/pi-embedded-subscribe.handlers.tools.js");

    const ctx = {
      params: { runId: "r", session: { messages: [] } },
      state: {
        toolMetaById: new Map<string, string | undefined>(),
        toolMetas: [] as Array<{ toolName?: string; meta?: string }>,
        toolSummaryById: new Set<string>(),
        lastToolError: undefined,
        pendingMessagingTexts: new Map<string, string>(),
        pendingMessagingTargets: new Map<string, unknown>(),
        messagingToolSentTexts: [] as string[],
        messagingToolSentTextsNormalized: [] as string[],
        messagingToolSentTargets: [] as unknown[],
      },
      log: { debug: vi.fn(), warn: vi.fn() },
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
      emitToolSummary: vi.fn(),
      emitToolOutput: vi.fn(),
      trimMessagingToolSent: vi.fn(),
    };

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId: "call-2",
        isError: false,
        result: {},
      } as never,
    );

    expect(hookMocks.runner.runAfterToolCall).not.toHaveBeenCalled();
  });
});
