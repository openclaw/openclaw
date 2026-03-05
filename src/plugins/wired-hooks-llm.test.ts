import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

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

  it("runLlmInput returns appendSystemPrompt from handler", async () => {
    const handler = vi.fn().mockResolvedValue({ appendSystemPrompt: "memory context here" });
    const registry = createMockPluginRegistry([{ hookName: "llm_input", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runLlmInput(
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

    expect(result).toEqual({ appendSystemPrompt: "memory context here" });
  });

  it("runLlmInput merges appendSystemPrompt from multiple handlers", async () => {
    const handler1 = vi.fn().mockResolvedValue({ appendSystemPrompt: "memory from plugin 1" });
    const handler2 = vi.fn().mockResolvedValue({ appendSystemPrompt: "memory from plugin 2" });
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

    expect(result?.appendSystemPrompt).toContain("memory from plugin 1");
    expect(result?.appendSystemPrompt).toContain("memory from plugin 2");
  });

  it("runLlmInput works with void-returning handlers (backward compat)", async () => {
    const handler = vi.fn(); // returns undefined
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
      {
        agentId: "main",
        sessionId: "session-1",
      },
    );

    expect(result).toBeUndefined();
    expect(handler).toHaveBeenCalled();
  });
});
