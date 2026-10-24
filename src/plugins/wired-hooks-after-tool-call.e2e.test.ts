import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBaseToolHandlerState } from "../agents/agent-tool-handler-state.test-helpers.js";
import { handleToolExecutionStart } from "../agents/embedded-agent-subscribe.handlers.tools.start.js";
import { endTool } from "../agents/embedded-agent-subscribe.handlers.tools.test-support.js";
import type { HookRunner } from "./hooks.js";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runBeforeToolCall: vi.fn(async () => {}),
    runAfterToolCall: vi.fn<HookRunner["runAfterToolCall"]>(async () => {}),
  },
}));

vi.mock("../infra/agent-events.js", () => ({
  emitAgentCommandOutputEvent: vi.fn(),
  emitAgentItemEvent: vi.fn(),
  emitAgentEvent: vi.fn(),
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));

function createToolHandlerCtx(params: {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}) {
  return {
    params: {
      ...params,
      session: { messages: [] },
    },
    hookRunner: hookMocks.runner,
    state: createBaseToolHandlerState(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    flushBlockReplyBuffer: vi.fn(),
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  };
}

function startTool(
  ctx: ReturnType<typeof createToolHandlerCtx>,
  toolName: string,
  toolCallId: string,
  args: unknown,
) {
  return handleToolExecutionStart(
    ctx as never,
    { type: "tool_execution_start", toolName, toolCallId, args } as never,
  );
}

function finishTool(
  ctx: ReturnType<typeof createToolHandlerCtx>,
  toolName: string,
  toolCallId: string,
  result: unknown,
  isError = false,
) {
  return endTool(
    ctx as never,
    { type: "tool_execution_end", toolName, toolCallId, isError, result } as never,
  );
}

const textResult = (text: string) => ({ content: [{ type: "text", text }] });

function expectAfterToolCallPayload(
  ctx: ReturnType<typeof createToolHandlerCtx>,
  toolCallId: string,
  args: unknown,
  result: unknown,
  index = 0,
) {
  const identity = { toolName: "read", runId: ctx.params.runId, toolCallId };
  const { agentId, sessionId, sessionKey } = ctx.params;
  expect(hookMocks.runner.runAfterToolCall).toHaveBeenNthCalledWith(
    index + 1,
    { ...identity, params: args, result, error: undefined, durationMs: expect.any(Number) },
    { ...identity, agentId, sessionId, sessionKey },
  );
}

describe("after_tool_call hook wiring", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("includes error in after_tool_call event on tool failure", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const ctx = createToolHandlerCtx({ runId: "test-run-2" });

    await startTool(ctx, "exec", "call-err", { command: "fail" });
    await finishTool(ctx, "exec", "call-err", { status: "error", error: "command failed" }, true);

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runAfterToolCall.mock.calls[0]).toEqual([
      expect.objectContaining({ error: "command failed" }),
      expect.objectContaining({ agentId: undefined }),
    ]);
  });

  it("does not call runAfterToolCall when no hooks registered", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);

    const ctx = createToolHandlerCtx({ runId: "r" });

    await finishTool(ctx, "exec", "call-2", {});

    expect(hookMocks.runner.runAfterToolCall).not.toHaveBeenCalled();
  });

  it("keeps start args isolated per run when toolCallId collides", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const sharedToolCallId = "shared-tool-call-id";

    const runContext = (id: string) =>
      createToolHandlerCtx({
        runId: `run-${id}`,
        sessionKey: `session-${id}`,
        sessionId: `ephemeral-${id}`,
        agentId: `agent-${id}`,
      });
    const ctxA = runContext("a");
    const ctxB = runContext("b");

    await startTool(ctxA, "read", sharedToolCallId, { path: "/tmp/path-a.txt" });
    await startTool(ctxB, "read", sharedToolCallId, { path: "/tmp/path-b.txt" });
    await finishTool(ctxA, "read", sharedToolCallId, textResult("done-a"));
    await finishTool(ctxB, "read", sharedToolCallId, textResult("done-b"));

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(2);
    expect(hookMocks.runner.runBeforeToolCall).not.toHaveBeenCalled();
    expectAfterToolCallPayload(
      ctxA,
      sharedToolCallId,
      { path: "/tmp/path-a.txt" },
      textResult("done-a"),
    );
    expectAfterToolCallPayload(
      ctxB,
      sharedToolCallId,
      { path: "/tmp/path-b.txt" },
      textResult("done-b"),
      1,
    );
  });
});
