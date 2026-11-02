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

function toolRun(id: string) {
  const ctx = {
    params: { session: { messages: [] } },
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
  const context = {
    runId: `run-${id}`,
    sessionKey: `session-${id}`,
    sessionId: `ephemeral-${id}`,
    agentId: `agent-${id}`,
    toolName: "read",
    toolCallId: "shared-tool-call-id",
  };
  Object.assign(ctx.params, context);
  const { toolName, toolCallId, runId } = context;
  return {
    start: (args: unknown) =>
      handleToolExecutionStart(ctx as never, {
        type: "tool_execution_start",
        toolName,
        toolCallId,
        args,
      }),
    finish: (result: unknown) => endTool(ctx as never, { toolName, toolCallId, result }),
    expectPayload: (index: number) =>
      expect(hookMocks.runner.runAfterToolCall).toHaveBeenNthCalledWith(
        index,
        {
          toolName,
          toolCallId,
          runId,
          params: { path: `/tmp/path-${id}.txt` },
          result: { content: [{ type: "text", text: `done-${id}` }] },
          error: undefined,
          durationMs: expect.any(Number),
        },
        context,
      ),
  };
}

describe("after_tool_call hook wiring", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("does not call runAfterToolCall when no hooks registered", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);
    await toolRun("no-hooks").finish({});
    expect(hookMocks.runner.runAfterToolCall).not.toHaveBeenCalled();
  });

  it("keeps start args isolated per run when toolCallId collides", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const a = toolRun("a"),
      b = toolRun("b");
    const argsA = { path: "/tmp/path-a.txt" },
      argsB = { path: "/tmp/path-b.txt" };
    const textResult = (text: string) => ({ content: [{ type: "text", text }] });
    const resultA = textResult("done-a"),
      resultB = textResult("done-b");
    await a.start(argsA);
    await b.start(argsB);
    await a.finish(resultA);
    await b.finish(resultB);
    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(2);
    expect(hookMocks.runner.runBeforeToolCall).not.toHaveBeenCalled();
    a.expectPayload(1);
    b.expectPayload(2);
  });
});
