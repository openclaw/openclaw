import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBaseToolHandlerState } from "../agents/agent-tool-handler-state.test-helpers.js";
import { resolveToolResultTerminalDiagnostic } from "../agents/agent-tools.before-tool-call.diagnostics.js";
import { handleToolExecutionStart } from "../agents/embedded-agent-subscribe.handlers.tools.start.js";
import { endTool } from "../agents/embedded-agent-subscribe.handlers.tools.test-support.js";
import type { PluginHookAfterToolCallEvent } from "./hook-types.js";
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

function toolRun(id: string, toolName = "read") {
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
    toolName,
    toolCallId: "shared-tool-call-id",
  };
  Object.assign(ctx.params, context);
  const { toolCallId, runId } = context;
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

function lastAfterToolCallEvent(): PluginHookAfterToolCallEvent {
  const calls = hookMocks.runner.runAfterToolCall.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0];
}

/** The hook observation must equal the canonical terminal diagnostic of the same result. */
function expectOutcomeMatchesDiagnostic(
  result: unknown,
  outcome: NonNullable<PluginHookAfterToolCallEvent["outcome"]>,
) {
  expect(resolveToolResultTerminalDiagnostic(result, 0).type).toBe(`tool.execution.${outcome}`);
}

describe("after_tool_call terminal outcome", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hookMocks.runner.hasHooks.mockReturnValue(true);
  });

  it("reports blocked for exec approval-unavailable that carries no error message", async () => {
    const run = toolRun("approval-unavailable", "exec");
    const result = {
      content: [{ type: "text" as const, text: "approval unavailable" }],
      details: { status: "approval-unavailable" },
    };
    await run.start({ command: "uname -a" });
    await run.finish(result);
    const event = lastAfterToolCallEvent();
    expect(event.outcome).toBe("blocked");
    // Baseline gap kept visible: approval-unavailable still yields no error text.
    expect(event.error).toBeUndefined();
    expect(event.result).toEqual(result);
    expectOutcomeMatchesDiagnostic(result, "blocked");
  });

  it("reports error for a structured failure with no message text", async () => {
    const run = toolRun("empty-structured-failure");
    const result = { content: [], details: { ok: false } };
    await run.start({ path: "/tmp/path-empty-structured-failure.txt" });
    await run.finish(result);
    const event = lastAfterToolCallEvent();
    expect(event.outcome).toBe("error");
    // extractToolErrorMessage finds no text here, so the hook error stays empty.
    expect(event.error).toBeUndefined();
    expectOutcomeMatchesDiagnostic(result, "error");
  });

  it("reports completed for a structured success", async () => {
    const run = toolRun("structured-success");
    const result = {
      content: [{ type: "text" as const, text: "done-structured-success" }],
      details: { ok: true },
    };
    await run.start({ path: "/tmp/path-structured-success.txt" });
    await run.finish(result);
    const event = lastAfterToolCallEvent();
    expect(event.outcome).toBe("completed");
    expectOutcomeMatchesDiagnostic(result, "completed");
    // Every pre-existing payload field survives next to the new field.
    expect(event).toMatchObject({
      toolName: "read",
      toolCallId: "shared-tool-call-id",
      runId: "run-structured-success",
      params: { path: "/tmp/path-structured-success.txt" },
      error: undefined,
    });
    expect(event.durationMs).toBeTypeOf("number");
    expect("result" in event).toBe(true);
  });

  it("omits outcome when the result carries no structured outcome", async () => {
    const run = toolRun("unknown-outcome");
    await run.start({ path: "/tmp/path-unknown-outcome.txt" });
    await run.finish({ content: [{ type: "text", text: "done-unknown-outcome" }] });
    const event = lastAfterToolCallEvent();
    expect(event).not.toHaveProperty("outcome");
    expect(event.result).toEqual({ content: [{ type: "text", text: "done-unknown-outcome" }] });
    expect(event.durationMs).toBeTypeOf("number");
  });
});
