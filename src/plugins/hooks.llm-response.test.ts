import type { AgentMessage } from "@mariozechner/pi-agent-core";
/**
 * Unit tests for LLM call and response emit hooks:
 * before_llm_call, after_llm_call, before_response_emit.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import type { PluginRegistry } from "./registry.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeLlmCallEvent,
  PluginHookAfterLlmCallEvent,
  PluginHookBeforeResponseEmitEvent,
  PluginHookRegistration,
} from "./types.js";

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
    // Sequential merge in registration order: last non-undefined wins for each field
    expect(result?.tools).toEqual([{ name: "exec" }]);
    // second runs last and provides systemPrompt → its value wins
    expect(result?.systemPrompt).toBe("second prompt");
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
      makeRegistry([{ pluginId: "p1", hookName: "after_llm_call", handler, source: "test" }]),
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

  it("runs multiple handlers in parallel (void)", async () => {
    const h1 = vi.fn().mockResolvedValue(undefined);
    const h2 = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "after_llm_call", handler: h1, source: "test" },
        { pluginId: "p2", hookName: "after_llm_call", handler: h2, source: "test" },
      ]),
    );

    await runner.runAfterLlmCall(baseEvent, agentCtx);
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("skips when no handlers registered", async () => {
    const runner = createHookRunner(makeRegistry([]));
    await runner.runAfterLlmCall(baseEvent, agentCtx);
    // No error, no-op
  });
});

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

          source: "test",
        },
        {
          pluginId: "p2",
          hookName: "before_response_emit",
          handler: h2,

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
