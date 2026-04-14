/**
 * Tests for before_tool_call and after_tool_call hooks with veto support.
 *
 * These tests verify:
 * 1. Hook payload structure (toolName, params)
 * 2. Veto mechanism (block=true prevents execution)
 * 3. Structured blocked result with blockReason
 * 4. after_tool_call receives result, error, durationMs
 * 5. sessionKey presence in hook context
 * 6. Parameter modification by hooks
 * 7. Normal execution when no hooks registered
 * 8. Hook error resilience (errors don't block execution)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Must hoist mock setup before imports
const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runBeforeToolCall: vi.fn(async () => undefined),
    runAfterToolCall: vi.fn(async () => undefined),
  },
}));

vi.mock("./hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

// Mock diagnostic session state to avoid test pollution
vi.mock("../logging/diagnostic-session-state.js", () => ({
  getDiagnosticSessionState: () => ({
    toolLoopWarningBuckets: new Map(),
  }),
  resetDiagnosticSessionStateForTest: vi.fn(),
}));

// Mock tool loop detection to isolate hook tests
vi.mock("../agents/tool-loop-detection.js", () => ({
  detectToolCallLoop: () => ({ stuck: false }),
  recordToolCall: vi.fn(),
  recordToolCallOutcome: vi.fn(),
}));

// Mock diagnostic logging
vi.mock("../logging/diagnostic.js", () => ({
  logToolLoopAction: vi.fn(),
}));

// Mock agent events (used by handlers)
vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

import { wrapToolWithBeforeToolCallHook } from "../agents/pi-tools.before-tool-call.js";
import type { AnyAgentTool } from "../agents/tools/common.js";

describe("tool call hooks", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runBeforeToolCall.mockReset();
    hookMocks.runner.runBeforeToolCall.mockResolvedValue(undefined);
    hookMocks.runner.runAfterToolCall.mockReset();
    hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);
  });

  describe("before_tool_call hook", () => {
    it("receives correct event payload with toolName and params", async () => {
      hookMocks.runner.hasHooks.mockReturnValue(true);
      hookMocks.runner.runBeforeToolCall.mockResolvedValue(undefined);

      const execute = vi.fn().mockResolvedValue({ content: [], details: {} });
      const tool = wrapToolWithBeforeToolCallHook(
        { name: "ReadFile", execute } as unknown as AnyAgentTool,
        { agentId: "main", sessionKey: "session-123" },
      );

      await tool.execute("call-1", { path: "/tmp/file.txt" }, undefined, undefined);

      expect(hookMocks.runner.runBeforeToolCall).toHaveBeenCalledTimes(1);
      expect(hookMocks.runner.runBeforeToolCall).toHaveBeenCalledWith(
        { toolName: "readfile", params: { path: "/tmp/file.txt" } },
        { toolName: "readfile", agentId: "main", sessionKey: "session-123" },
      );
    });

    it("blocks tool execution when hook returns block=true", async () => {
      hookMocks.runner.hasHooks.mockReturnValue(true);
      hookMocks.runner.runBeforeToolCall.mockResolvedValue({
        block: true,
        blockReason: "denied by policy",
      });

      const execute = vi.fn().mockResolvedValue({ content: [], details: {} });
      const tool = wrapToolWithBeforeToolCallHook(
        { name: "exec", execute } as unknown as AnyAgentTool,
        { agentId: "main", sessionKey: "session-123" },
      );

      await expect(
        tool.execute("call-1", { cmd: "rm -rf /" }, undefined, undefined),
      ).rejects.toThrow("denied by policy");

      expect(execute).not.toHaveBeenCalled();
    });

    it("blocked tool call includes blockReason in error", async () => {
      hookMocks.runner.hasHooks.mockReturnValue(true);
      hookMocks.runner.runBeforeToolCall.mockResolvedValue({
        block: true,
        blockReason: "Tool 'exec' blocked: dangerous command detected",
      });

      const execute = vi.fn();
      const tool = wrapToolWithBeforeToolCallHook(
        { name: "exec", execute } as unknown as AnyAgentTool,
        { agentId: "test", sessionKey: "sess" },
      );

      const error = await tool.execute("call-1", {}, undefined, undefined).catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("dangerous command detected");
    });

    it("sessionKey is present in hook context", async () => {
      hookMocks.runner.hasHooks.mockReturnValue(true);
      hookMocks.runner.runBeforeToolCall.mockResolvedValue(undefined);

      const tool = wrapToolWithBeforeToolCallHook(
        { name: "read", execute: vi.fn().mockResolvedValue({}) } as unknown as AnyAgentTool,
        { agentId: "agent-1", sessionKey: "sess-abc-123" },
      );

      await tool.execute("call-1", {}, undefined, undefined);

      const [, context] = hookMocks.runner.runBeforeToolCall.mock.calls[0];
      expect(context.sessionKey).toBe("sess-abc-123");
      expect(context.agentId).toBe("agent-1");
      expect(context.toolName).toBe("read");
    });

    it("allows hook to modify parameters", async () => {
      hookMocks.runner.hasHooks.mockReturnValue(true);
      hookMocks.runner.runBeforeToolCall.mockResolvedValue({ params: { mode: "safe" } });

      const execute = vi.fn().mockResolvedValue({ content: [] });
      const tool = wrapToolWithBeforeToolCallHook(
        { name: "exec", execute } as unknown as AnyAgentTool,
        { agentId: "main", sessionKey: "sess" },
      );

      await tool.execute("call-1", { cmd: "ls" }, undefined, undefined);

      expect(execute).toHaveBeenCalledWith(
        "call-1",
        { cmd: "ls", mode: "safe" }, // merged params
        undefined,
        undefined,
      );
    });

    it("executes tool normally when no hooks registered", async () => {
      hookMocks.runner.hasHooks.mockReturnValue(false);

      const execute = vi.fn().mockResolvedValue({ content: [] });
      const tool = wrapToolWithBeforeToolCallHook(
        { name: "read", execute } as unknown as AnyAgentTool,
        { agentId: "main", sessionKey: "s" },
      );

      await tool.execute("call-1", { path: "/file" }, undefined, undefined);

      expect(hookMocks.runner.runBeforeToolCall).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith("call-1", { path: "/file" }, undefined, undefined);
    });

    it("continues execution when hook throws", async () => {
      hookMocks.runner.hasHooks.mockReturnValue(true);
      hookMocks.runner.runBeforeToolCall.mockRejectedValue(new Error("hook crashed"));

      const execute = vi.fn().mockResolvedValue({ content: [] });
      const tool = wrapToolWithBeforeToolCallHook(
        { name: "read", execute } as unknown as AnyAgentTool,
        { agentId: "main", sessionKey: "sess" },
      );

      await tool.execute("call-1", { path: "/file" }, undefined, undefined);

      expect(execute).toHaveBeenCalled(); // execution continues despite hook error
    });
  });

  describe("after_tool_call hook (via handlers)", () => {
    // Helper to create tool handler context
    function createToolHandlerCtx(params: {
      runId: string;
      sessionKey?: string;
      agentId?: string;
      onBlockReplyFlush?: unknown;
    }) {
      return {
        params: {
          runId: params.runId,
          session: { messages: [] },
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          onBlockReplyFlush: params.onBlockReplyFlush,
        },
        state: {
          toolMetaById: new Map<string, string | undefined>(),
          toolMetas: [] as Array<{ toolName?: string; meta?: string }>,
          toolSummaryById: new Set<string>(),
          lastToolError: undefined,
          pendingMessagingTexts: new Map<string, string>(),
          pendingMessagingTargets: new Map<string, unknown>(),
          pendingMessagingMediaUrls: new Map<string, string>(),
          messagingToolSentTexts: [] as string[],
          messagingToolSentTextsNormalized: [] as string[],
          messagingToolSentMediaUrls: [] as string[],
          messagingToolSentTargets: [] as unknown[],
          blockBuffer: "",
          successfulCronAdds: 0,
        },
        log: { debug: vi.fn(), warn: vi.fn() },
        flushBlockReplyBuffer: vi.fn(),
        shouldEmitToolResult: () => false,
        shouldEmitToolOutput: () => false,
        emitToolSummary: vi.fn(),
        emitToolOutput: vi.fn(),
        trimMessagingToolSent: vi.fn(),
        hookRunner: hookMocks.runner,
      };
    }

    it("receives result and durationMs on success", async () => {
      hookMocks.runner.hasHooks.mockReturnValue(true);
      hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);

      const { handleToolExecutionEnd, handleToolExecutionStart } =
        await import("../agents/pi-embedded-subscribe.handlers.tools.js");

      const ctx = createToolHandlerCtx({
        runId: "test-run",
        agentId: "main",
        sessionKey: "session-123",
      });

      await handleToolExecutionStart(
        ctx as never,
        {
          type: "tool_execution_start",
          toolName: "read",
          toolCallId: "call-1",
          args: { path: "/tmp/file" },
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
      expect(event.params).toEqual({ path: "/tmp/file" });
      expect(event.result).toBeDefined();
      expect(event.error).toBeUndefined();
      expect(typeof event.durationMs).toBe("number");
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(context.toolName).toBe("read");
    });

    it("receives error on tool failure", async () => {
      hookMocks.runner.hasHooks.mockReturnValue(true);
      hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);

      const { handleToolExecutionEnd, handleToolExecutionStart } =
        await import("../agents/pi-embedded-subscribe.handlers.tools.js");

      const ctx = createToolHandlerCtx({ runId: "test-run-2" });

      await handleToolExecutionStart(
        ctx as never,
        {
          type: "tool_execution_start",
          toolName: "exec",
          toolCallId: "call-err",
          args: { cmd: "fail" },
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
      expect(event.toolName).toBe("exec");
    });
  });
});
