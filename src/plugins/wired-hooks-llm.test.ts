import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("after_tool_call hook runner (modifying)", () => {
  it("runAfterToolCall returns modified result from handler", async () => {
    const handler = vi.fn().mockReturnValue({ result: { redacted: true } });
    const registry = createMockPluginRegistry([{ hookName: "after_tool_call", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runAfterToolCall(
      { toolName: "read", params: { path: "/secret" }, result: { content: "secret data" } },
      { toolName: "read" },
    );

    expect(result).toEqual({ result: { redacted: true } });
  });

  it("runAfterToolCall returns undefined when no hooks registered", async () => {
    const registry = createMockPluginRegistry([]);
    const runner = createHookRunner(registry);

    const result = await runner.runAfterToolCall(
      { toolName: "read", params: {}, result: { content: "ok" } },
      { toolName: "read" },
    );

    expect(result).toBeUndefined();
  });

  it("runAfterToolCall returns undefined when handler returns void", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "after_tool_call", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runAfterToolCall(
      { toolName: "read", params: {}, result: { content: "ok" } },
      { toolName: "read" },
    );

    expect(result).toBeUndefined();
  });

  it("runAfterToolCall last handler result wins", async () => {
    const handler1 = vi.fn().mockReturnValue({ result: { v: 1 } });
    const handler2 = vi.fn().mockReturnValue({ result: { v: 2 } });
    const registry = createMockPluginRegistry([
      { hookName: "after_tool_call", handler: handler1 },
      { hookName: "after_tool_call", handler: handler2 },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runAfterToolCall(
      { toolName: "read", params: {}, result: {} },
      { toolName: "read" },
    );

    expect(result?.result).toEqual({ v: 2 });
  });
});

describe("llm hook runner methods", () => {
  it("runLlmInput invokes registered llm_input hooks", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "llm_input", handler }]);
    const runner = createHookRunner(registry);

    await runner.runLlmInput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        systemPrompt: "be helpful",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "main",
        sessionId: "session-1",
      },
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", prompt: "hello" }),
      expect.objectContaining({ sessionId: "session-1" }),
    );
  });

  it("runLlmOutput invokes registered llm_output hooks", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "llm_output", handler }]);
    const runner = createHookRunner(registry);

    await runner.runLlmOutput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        assistantTexts: ["hi"],
        lastAssistant: { role: "assistant", content: "hi" },
        usage: {
          input: 10,
          output: 20,
          total: 30,
        },
      },
      {
        agentId: "main",
        sessionId: "session-1",
      },
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", assistantTexts: ["hi"] }),
      expect.objectContaining({ sessionId: "session-1" }),
    );
  });

  it("hasHooks returns true for registered llm hooks", () => {
    const registry = createMockPluginRegistry([{ hookName: "llm_input", handler: vi.fn() }]);
    const runner = createHookRunner(registry);

    expect(runner.hasHooks("llm_input")).toBe(true);
    expect(runner.hasHooks("llm_output")).toBe(false);
  });

  it("runLlmInput returns modified prompt from handler", async () => {
    const handler = vi.fn().mockReturnValue({ prompt: "redacted prompt" });
    const registry = createMockPluginRegistry([{ hookName: "llm_input", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runLlmInput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        prompt: "secret data here",
        historyMessages: [],
        imagesCount: 0,
      },
      { agentId: "main", sessionId: "session-1" },
    );

    expect(result).toEqual({ prompt: "redacted prompt" });
  });

  it("runLlmInput returns block=true to abort LLM call", async () => {
    const handler = vi.fn().mockReturnValue({ block: true, blockReason: "PII detected" });
    const registry = createMockPluginRegistry([{ hookName: "llm_input", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runLlmInput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { agentId: "main", sessionId: "session-1" },
    );

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("PII detected");
  });

  it("runLlmInput returns undefined when no hooks registered", async () => {
    const registry = createMockPluginRegistry([]);
    const runner = createHookRunner(registry);

    const result = await runner.runLlmInput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { agentId: "main", sessionId: "session-1" },
    );

    expect(result).toBeUndefined();
  });

  it("runLlmInput merges results from multiple handlers", async () => {
    const handler1 = vi.fn().mockReturnValue({ prompt: "modified prompt" });
    const handler2 = vi.fn().mockReturnValue({ systemPrompt: "new system prompt" });
    const registry = createMockPluginRegistry([
      { hookName: "llm_input", handler: handler1 },
      { hookName: "llm_input", handler: handler2 },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runLlmInput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { agentId: "main", sessionId: "session-1" },
    );

    expect(result?.prompt).toBe("modified prompt");
    expect(result?.systemPrompt).toBe("new system prompt");
  });
});
