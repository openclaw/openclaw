import type { AgentMessage } from "@mariozechner/pi-agent-core";
/**
 * Unit tests for before_llm_call hook merge semantics.
 *
 * See hooks.context-loop.test.ts for context_assembled and loop_iteration tests.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import type { PluginRegistry } from "./registry.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeLlmCallEvent,
  PluginHookAfterLlmCallEvent,
  PluginHookRegistration,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(hooks: PluginHookRegistration[]) {
  return { typedHooks: hooks } as unknown as PluginRegistry;
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
      makeRegistry([{ pluginId: "p1", hookName: "before_llm_call", handler, source: "test" }]),
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
      makeRegistry([{ pluginId: "p1", hookName: "before_llm_call", handler, source: "test" }]),
    );

    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    expect(result?.messages).toBe(newMsgs);
  });

  it("returns modified systemPrompt when handler provides it", async () => {
    const handler = vi.fn().mockResolvedValue({ systemPrompt: "new prompt" });
    const runner = createHookRunner(
      makeRegistry([{ pluginId: "p1", hookName: "before_llm_call", handler, source: "test" }]),
    );

    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    expect(result?.systemPrompt).toBe("new prompt");
  });

  it("returns filtered tools when handler provides them", async () => {
    const handler = vi.fn().mockResolvedValue({ tools: [{ name: "read" }] });
    const runner = createHookRunner(
      makeRegistry([{ pluginId: "p1", hookName: "before_llm_call", handler, source: "test" }]),
    );

    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    expect(result?.tools).toEqual([{ name: "read" }]);
  });

  it("returns block=true and blockReason when handler blocks", async () => {
    const handler = vi.fn().mockResolvedValue({ block: true, blockReason: "too many tokens" });
    const runner = createHookRunner(
      makeRegistry([{ pluginId: "p1", hookName: "before_llm_call", handler, source: "test" }]),
    );

    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("too many tokens");
  });

  it("merges results from multiple handlers in registration order (FIFO)", async () => {
    const first = vi
      .fn()
      .mockResolvedValue({ systemPrompt: "first prompt", tools: [{ name: "exec" }] });
    const second = vi.fn().mockResolvedValue({ systemPrompt: "second prompt" });
    const runner = createHookRunner(
      makeRegistry([
        {
          pluginId: "first",
          hookName: "before_llm_call",
          handler: first,
          source: "test",
        },
        {
          pluginId: "second",
          hookName: "before_llm_call",
          handler: second,
          source: "test",
        },
      ]),
    );

    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    // First-writer-wins for messages/systemPrompt: first plugin to set wins
    expect(result?.tools).toEqual([{ name: "exec" }]);
    // first runs first and provides systemPrompt → its value wins (security-first)
    expect(result?.systemPrompt).toBe("first prompt");
    // first ran before second (registration order)
    expect(first).toHaveBeenCalledBefore(second);
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

          source: "test",
        },
        {
          pluginId: "good",
          hookName: "before_llm_call",
          handler: goodHandler,

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
    response: { role: "assistant", content: [], timestamp: Date.now() } as AgentMessage,
    toolCalls: [
      { id: "tc1", name: "read", arguments: { path: "/a" } },
      { id: "tc2", name: "write", arguments: { path: "/b" } },
    ],
    iteration: 1,
    model: "test-model",
  };

  it("merges block from multiple handlers (one-way latch)", async () => {
    const hooks: PluginHookRegistration[] = [
      {
        pluginId: "a",
        hookName: "after_llm_call",
        handler: async () => ({ block: false }),
        priority: 10,
        source: "test",
      },
      {
        pluginId: "b",
        hookName: "after_llm_call",
        handler: async () => ({ block: true, blockReason: "policy" }),
        priority: 5,
        source: "test",
      },
    ];
    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runAfterLlmCall(baseEvent, agentCtx);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("policy");
  });

  it("uses first blockReason (first-writer-wins)", async () => {
    const hooks: PluginHookRegistration[] = [
      {
        pluginId: "a",
        hookName: "after_llm_call",
        handler: async () => ({ block: true, blockReason: "reason A" }),
        priority: 10,
        source: "test",
      },
      {
        pluginId: "b",
        hookName: "after_llm_call",
        handler: async () => ({ block: true, blockReason: "reason B" }),
        priority: 5,
        source: "test",
      },
    ];
    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runAfterLlmCall(baseEvent, agentCtx);
    expect(result?.blockReason).toBe("reason A");
  });

  it("intersects toolCalls from multiple handlers", async () => {
    const hooks: PluginHookRegistration[] = [
      {
        pluginId: "a",
        hookName: "after_llm_call",
        handler: async () => ({
          toolCalls: [
            { id: "tc1", name: "read", arguments: {} },
            { id: "tc2", name: "write", arguments: {} },
          ],
        }),
        priority: 10,
        source: "test",
      },
      {
        pluginId: "b",
        hookName: "after_llm_call",
        handler: async () => ({
          toolCalls: [{ id: "tc1", name: "read", arguments: {} }],
        }),
        priority: 5,
        source: "test",
      },
    ];
    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runAfterLlmCall(baseEvent, agentCtx);
    expect(result?.toolCalls?.map((t) => t.id)).toEqual(["tc1"]);
  });

  it("returns undefined when no handlers registered", async () => {
    const runner = createHookRunner(makeRegistry([]));
    const result = await runner.runAfterLlmCall(baseEvent, agentCtx);
    expect(result).toBeUndefined();
  });
});
