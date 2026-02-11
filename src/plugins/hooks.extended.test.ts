import type { AgentMessage } from "@mariozechner/pi-agent-core";
/**
 * Unit tests for the 6 extended security / agent loop observability hooks.
 *
 * These hooks were added to give plugins fine-grained visibility and control
 * over the agent loop: before_llm_call, after_llm_call, context_assembled,
 * loop_iteration_start, loop_iteration_end, before_response_emit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginHookAgentContext,
  PluginHookBeforeLlmCallEvent,
  PluginHookAfterLlmCallEvent,
  PluginHookContextAssembledEvent,
  PluginHookLoopIterationStartEvent,
  PluginHookLoopIterationEndEvent,
  PluginHookBeforeResponseEmitEvent,
  PluginHookRegistration,
} from "./types.js";
import { createHookRunner } from "./hooks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(hooks: PluginHookRegistration[]) {
  return { typedHooks: hooks } as any;
}

const agentCtx: PluginHookAgentContext = {
  agentId: "test-agent",
  sessionKey: "test-session",
};

function fakeMsg(role: string, content: string): AgentMessage {
  return { role, content } as AgentMessage;
}

// ---------------------------------------------------------------------------
// before_llm_call (modifying, sequential)
// ---------------------------------------------------------------------------

describe("before_llm_call hook", () => {
  const baseEvent: PluginHookBeforeLlmCallEvent = {
    messages: [fakeMsg("user", "hello")],
    systemPrompt: "You are helpful.",
    model: "gpt-4",
    iteration: 0,
    tools: [{ name: "read", description: "Read files" }, { name: "exec" }],
    tokenEstimate: 100,
  };

  it("fires handler with correct event shape", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "before_llm_call", handler, priority: 0, source: "test" },
      ]),
    );

    await runner.runBeforeLlmCall(baseEvent, agentCtx);

    expect(handler).toHaveBeenCalledOnce();
    const [event, ctx] = handler.mock.calls[0];
    expect(event).toMatchObject({
      messages: baseEvent.messages,
      systemPrompt: "You are helpful.",
      model: "gpt-4",
      iteration: 0,
      tools: baseEvent.tools,
      tokenEstimate: 100,
    });
    expect(ctx).toBe(agentCtx);
  });

  it("returns modified messages when handler provides them", async () => {
    const newMsgs = [fakeMsg("user", "modified")];
    const handler = vi.fn().mockResolvedValue({ messages: newMsgs });
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "before_llm_call", handler, priority: 0, source: "test" },
      ]),
    );

    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    expect(result?.messages).toBe(newMsgs);
  });

  it("returns modified systemPrompt when handler provides it", async () => {
    const handler = vi.fn().mockResolvedValue({ systemPrompt: "new prompt" });
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "before_llm_call", handler, priority: 0, source: "test" },
      ]),
    );

    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    expect(result?.systemPrompt).toBe("new prompt");
  });

  it("returns filtered tools when handler provides them", async () => {
    const handler = vi.fn().mockResolvedValue({ tools: [{ name: "read" }] });
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "before_llm_call", handler, priority: 0, source: "test" },
      ]),
    );

    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    expect(result?.tools).toEqual([{ name: "read" }]);
  });

  it("returns block=true and blockReason when handler blocks", async () => {
    const handler = vi.fn().mockResolvedValue({ block: true, blockReason: "too many tokens" });
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "before_llm_call", handler, priority: 0, source: "test" },
      ]),
    );

    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("too many tokens");
  });

  it("merges results from multiple handlers (higher priority first)", async () => {
    const lowPri = vi
      .fn()
      .mockResolvedValue({ systemPrompt: "low-pri prompt", tools: [{ name: "exec" }] });
    const highPri = vi.fn().mockResolvedValue({ systemPrompt: "high-pri prompt" });
    const runner = createHookRunner(
      makeRegistry([
        {
          pluginId: "low",
          hookName: "before_llm_call",
          handler: lowPri,
          priority: 1,
          source: "test",
        },
        {
          pluginId: "high",
          hookName: "before_llm_call",
          handler: highPri,
          priority: 10,
          source: "test",
        },
      ]),
    );

    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    // high priority runs first → sets systemPrompt; low priority runs second → overwrites systemPrompt, adds tools
    // sequential merge: last non-undefined wins for each field
    expect(result?.tools).toEqual([{ name: "exec" }]);
    // low-pri runs last and provides systemPrompt → its value wins
    expect(result?.systemPrompt).toBe("low-pri prompt");
    // high-pri ran first (confirmed by call order)
    expect(highPri).toHaveBeenCalledBefore(lowPri);
  });

  it("continues on handler error when catchErrors=true", async () => {
    const badHandler = vi.fn().mockRejectedValue(new Error("boom"));
    const goodHandler = vi.fn().mockResolvedValue({ systemPrompt: "survived" });
    const runner = createHookRunner(
      makeRegistry([
        {
          pluginId: "bad",
          hookName: "before_llm_call",
          handler: badHandler,
          priority: 10,
          source: "test",
        },
        {
          pluginId: "good",
          hookName: "before_llm_call",
          handler: goodHandler,
          priority: 1,
          source: "test",
        },
      ]),
      { catchErrors: true },
    );

    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    expect(result?.systemPrompt).toBe("survived");
  });

  it("skips when no handlers registered (returns undefined)", async () => {
    const runner = createHookRunner(makeRegistry([]));
    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// after_llm_call (modifying, sequential)
// ---------------------------------------------------------------------------

describe("after_llm_call hook", () => {
  const baseEvent: PluginHookAfterLlmCallEvent = {
    response: fakeMsg("assistant", "Hello!"),
    toolCalls: [{ id: "tc-1", name: "read", arguments: { path: "/tmp/x" } }],
    iteration: 1,
    model: "gpt-4",
    latencyMs: 250,
    tokenUsage: { input: 50, output: 20 },
  };

  it("fires handler with correct event shape", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "after_llm_call", handler, priority: 0, source: "test" },
      ]),
    );

    await runner.runAfterLlmCall(baseEvent, agentCtx);

    expect(handler).toHaveBeenCalledOnce();
    const [event] = handler.mock.calls[0];
    expect(event).toMatchObject({
      response: baseEvent.response,
      toolCalls: baseEvent.toolCalls,
      iteration: 1,
      model: "gpt-4",
      latencyMs: 250,
      tokenUsage: { input: 50, output: 20 },
    });
  });

  it("returns modified toolCalls when handler provides them", async () => {
    const filtered = [{ id: "tc-1", name: "read", arguments: { path: "/safe" } }];
    const handler = vi.fn().mockResolvedValue({ toolCalls: filtered });
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "after_llm_call", handler, priority: 0, source: "test" },
      ]),
    );

    const result = await runner.runAfterLlmCall(baseEvent, agentCtx);
    expect(result?.toolCalls).toBe(filtered);
  });

  it("returns block=true when handler blocks", async () => {
    const handler = vi.fn().mockResolvedValue({ block: true, blockReason: "dangerous tool call" });
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "after_llm_call", handler, priority: 0, source: "test" },
      ]),
    );

    const result = await runner.runAfterLlmCall(baseEvent, agentCtx);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("dangerous tool call");
  });

  it("merges results from multiple handlers", async () => {
    const h1 = vi.fn().mockResolvedValue({ toolCalls: [] });
    const h2 = vi.fn().mockResolvedValue({ block: true, blockReason: "nope" });
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "after_llm_call", handler: h1, priority: 10, source: "test" },
        { pluginId: "p2", hookName: "after_llm_call", handler: h2, priority: 1, source: "test" },
      ]),
    );

    const result = await runner.runAfterLlmCall(baseEvent, agentCtx);
    // h2 runs after h1; block=true from h2 is merged on top
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("nope");
  });

  it("skips when no handlers registered", async () => {
    const runner = createHookRunner(makeRegistry([]));
    const result = await runner.runAfterLlmCall(baseEvent, agentCtx);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// context_assembled (void, parallel)
// ---------------------------------------------------------------------------

describe("context_assembled hook", () => {
  const baseEvent: PluginHookContextAssembledEvent = {
    systemPrompt: "You are helpful.",
    messages: [fakeMsg("user", "hi")],
    messageCount: 1,
    iteration: 0,
  };

  it("fires handler with correct event shape", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "context_assembled", handler, priority: 0, source: "test" },
      ]),
    );

    await runner.runContextAssembled(baseEvent, agentCtx);

    expect(handler).toHaveBeenCalledOnce();
    const [event, ctx] = handler.mock.calls[0];
    expect(event).toMatchObject({
      systemPrompt: "You are helpful.",
      messages: baseEvent.messages,
      messageCount: 1,
      iteration: 0,
    });
    expect(ctx).toBe(agentCtx);
  });

  it("runs all handlers (fire-and-forget) and does not return a value", async () => {
    const h1 = vi.fn().mockResolvedValue(undefined);
    const h2 = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "context_assembled", handler: h1, priority: 0, source: "test" },
        { pluginId: "p2", hookName: "context_assembled", handler: h2, priority: 0, source: "test" },
      ]),
    );

    const result = await runner.runContextAssembled(baseEvent, agentCtx);
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
    expect(result).toBeUndefined();
  });

  it("continues on handler error when catchErrors=true", async () => {
    const badHandler = vi.fn().mockRejectedValue(new Error("boom"));
    const goodHandler = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        {
          pluginId: "bad",
          hookName: "context_assembled",
          handler: badHandler,
          priority: 0,
          source: "test",
        },
        {
          pluginId: "good",
          hookName: "context_assembled",
          handler: goodHandler,
          priority: 0,
          source: "test",
        },
      ]),
      { catchErrors: true },
    );

    // Should not throw
    await runner.runContextAssembled(baseEvent, agentCtx);
    expect(goodHandler).toHaveBeenCalledOnce();
  });

  it("skips when no handlers registered", async () => {
    const runner = createHookRunner(makeRegistry([]));
    const result = await runner.runContextAssembled(baseEvent, agentCtx);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// loop_iteration_start (void, parallel)
// ---------------------------------------------------------------------------

describe("loop_iteration_start hook", () => {
  const baseEvent: PluginHookLoopIterationStartEvent = {
    iteration: 2,
    pendingToolResults: 3,
    messageCount: 10,
  };

  it("fires handler with correct event shape", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        {
          pluginId: "p1",
          hookName: "loop_iteration_start",
          handler,
          priority: 0,
          source: "test",
        },
      ]),
    );

    await runner.runLoopIterationStart(baseEvent, agentCtx);

    expect(handler).toHaveBeenCalledOnce();
    const [event] = handler.mock.calls[0];
    expect(event).toMatchObject({
      iteration: 2,
      pendingToolResults: 3,
      messageCount: 10,
    });
  });

  it("runs in parallel", async () => {
    const h1 = vi.fn().mockResolvedValue(undefined);
    const h2 = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        {
          pluginId: "p1",
          hookName: "loop_iteration_start",
          handler: h1,
          priority: 0,
          source: "test",
        },
        {
          pluginId: "p2",
          hookName: "loop_iteration_start",
          handler: h2,
          priority: 0,
          source: "test",
        },
      ]),
    );

    await runner.runLoopIterationStart(baseEvent, agentCtx);
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("skips when no handlers registered", async () => {
    const runner = createHookRunner(makeRegistry([]));
    const result = await runner.runLoopIterationStart(baseEvent, agentCtx);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// loop_iteration_end (void, parallel)
// ---------------------------------------------------------------------------

describe("loop_iteration_end hook", () => {
  const baseEvent: PluginHookLoopIterationEndEvent = {
    iteration: 3,
    toolCallsMade: 2,
    newMessagesAdded: 4,
    willContinue: true,
  };

  it("fires handler with correct event shape", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        {
          pluginId: "p1",
          hookName: "loop_iteration_end",
          handler,
          priority: 0,
          source: "test",
        },
      ]),
    );

    await runner.runLoopIterationEnd(baseEvent, agentCtx);

    expect(handler).toHaveBeenCalledOnce();
    const [event] = handler.mock.calls[0];
    expect(event).toMatchObject({
      iteration: 3,
      toolCallsMade: 2,
      newMessagesAdded: 4,
      willContinue: true,
    });
  });

  it("runs in parallel", async () => {
    const h1 = vi.fn().mockResolvedValue(undefined);
    const h2 = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        {
          pluginId: "p1",
          hookName: "loop_iteration_end",
          handler: h1,
          priority: 0,
          source: "test",
        },
        {
          pluginId: "p2",
          hookName: "loop_iteration_end",
          handler: h2,
          priority: 0,
          source: "test",
        },
      ]),
    );

    await runner.runLoopIterationEnd(baseEvent, agentCtx);
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("skips when no handlers registered", async () => {
    const runner = createHookRunner(makeRegistry([]));
    const result = await runner.runLoopIterationEnd(baseEvent, agentCtx);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// before_response_emit (modifying, sequential)
// ---------------------------------------------------------------------------

describe("before_response_emit hook", () => {
  const baseEvent: PluginHookBeforeResponseEmitEvent = {
    content: "Here is the answer.",
    channel: "discord",
    messageCount: 5,
  };

  it("fires handler with correct event shape", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        {
          pluginId: "p1",
          hookName: "before_response_emit",
          handler,
          priority: 0,
          source: "test",
        },
      ]),
    );

    await runner.runBeforeResponseEmit(baseEvent, agentCtx);

    expect(handler).toHaveBeenCalledOnce();
    const [event, ctx] = handler.mock.calls[0];
    expect(event).toMatchObject({
      content: "Here is the answer.",
      channel: "discord",
      messageCount: 5,
    });
    expect(ctx).toBe(agentCtx);
  });

  it("returns modified content when handler provides it", async () => {
    const handler = vi.fn().mockResolvedValue({ content: "[REDACTED]" });
    const runner = createHookRunner(
      makeRegistry([
        {
          pluginId: "p1",
          hookName: "before_response_emit",
          handler,
          priority: 0,
          source: "test",
        },
      ]),
    );

    const result = await runner.runBeforeResponseEmit(baseEvent, agentCtx);
    expect(result?.content).toBe("[REDACTED]");
  });

  it("returns block=true when handler blocks", async () => {
    const handler = vi.fn().mockResolvedValue({ block: true, blockReason: "PII detected" });
    const runner = createHookRunner(
      makeRegistry([
        {
          pluginId: "p1",
          hookName: "before_response_emit",
          handler,
          priority: 0,
          source: "test",
        },
      ]),
    );

    const result = await runner.runBeforeResponseEmit(baseEvent, agentCtx);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("PII detected");
  });

  it("merges results from multiple handlers", async () => {
    const h1 = vi.fn().mockResolvedValue({ content: "modified" });
    const h2 = vi.fn().mockResolvedValue({ block: true, blockReason: "policy" });
    const runner = createHookRunner(
      makeRegistry([
        {
          pluginId: "p1",
          hookName: "before_response_emit",
          handler: h1,
          priority: 10,
          source: "test",
        },
        {
          pluginId: "p2",
          hookName: "before_response_emit",
          handler: h2,
          priority: 1,
          source: "test",
        },
      ]),
    );

    const result = await runner.runBeforeResponseEmit(baseEvent, agentCtx);
    // h1 runs first (higher priority), h2 runs second (lower priority).
    // Merge: block and blockReason from h2 override; content stays from h1
    // since h2 doesn't provide content.
    // Actually with the merge function: next.content ?? acc?.content — h2 returns no content,
    // so acc.content ("modified") survives.
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("policy");
    expect(result?.content).toBe("modified");
  });

  it("skips when no handlers registered", async () => {
    const runner = createHookRunner(makeRegistry([]));
    const result = await runner.runBeforeResponseEmit(baseEvent, agentCtx);
    expect(result).toBeUndefined();
  });
});
