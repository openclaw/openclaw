import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook, createMockPluginRegistry } from "./hooks.test-helpers.js";

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

  it("runLlmInput returns prompt and history overrides", async () => {
    const handler = vi.fn().mockResolvedValue({
      prompt: "redacted prompt",
      historyMessages: [{ role: "user", content: "trimmed history" }],
    });
    const registry = createMockPluginRegistry([{ hookName: "llm_input", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runLlmInput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        systemPrompt: "be helpful",
        prompt: "original prompt",
        historyMessages: [{ role: "user", content: "original history" }],
        imagesCount: 0,
      },
      { agentId: "main", sessionId: "session-1" },
    );

    expect(result).toEqual({
      prompt: "redacted prompt",
      historyMessages: [{ role: "user", content: "trimmed history" }],
    });
  });

  it("runLlmInput preserves backward compatibility when handler returns void", async () => {
    const handler = vi.fn(); // undefined return
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

    expect(result).toBeUndefined();
  });

  it("runLlmInput merges prompt/history across multiple handlers", async () => {
    const registry = createMockPluginRegistry([
      { hookName: "llm_input", handler: vi.fn().mockResolvedValue({ prompt: "first prompt" }) },
      {
        hookName: "llm_input",
        handler: vi.fn().mockResolvedValue({
          historyMessages: [{ role: "assistant", content: "history override" }],
        }),
      },
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

    expect(result).toEqual({
      prompt: "first prompt",
      historyMessages: [{ role: "assistant", content: "history override" }],
    });
  });

  it("runLlmInput keeps higher-priority prompt override on conflicts", async () => {
    const registry = createMockPluginRegistry([]);
    addTestHook({
      registry,
      pluginId: "high-priority",
      hookName: "llm_input",
      priority: 10,
      handler: vi.fn().mockResolvedValue({ prompt: "high-priority prompt" }),
    });
    addTestHook({
      registry,
      pluginId: "low-priority",
      hookName: "llm_input",
      priority: 1,
      handler: vi.fn().mockResolvedValue({ prompt: "low-priority prompt" }),
    });

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

    expect(result).toEqual({ prompt: "high-priority prompt", historyMessages: undefined });
  });

  it("runLlmOutput returns modified assistant texts", async () => {
    const handler = vi.fn().mockResolvedValue({ assistantTexts: ["rehydrated response"] });
    const registry = createMockPluginRegistry([{ hookName: "llm_output", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runLlmOutput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        assistantTexts: ["raw masked response"],
        lastAssistant: { role: "assistant", content: "raw masked response" },
        usage: { input: 10, output: 20, total: 30 },
      },
      { agentId: "main", sessionId: "session-1" },
    );

    expect(result).toEqual({ assistantTexts: ["rehydrated response"] });
  });

  it("runLlmOutput preserves backward compatibility when handler returns void", async () => {
    const handler = vi.fn(); // undefined return
    const registry = createMockPluginRegistry([{ hookName: "llm_output", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runLlmOutput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        assistantTexts: ["hi"],
        usage: { input: 10, output: 20, total: 30 },
      },
      { agentId: "main", sessionId: "session-1" },
    );

    expect(result).toBeUndefined();
  });

  it("runLlmOutput keeps higher-priority assistant override on conflicts", async () => {
    const registry = createMockPluginRegistry([]);
    addTestHook({
      registry,
      pluginId: "high-priority",
      hookName: "llm_output",
      priority: 10,
      handler: vi.fn().mockResolvedValue({ assistantTexts: ["high-priority text"] }),
    });
    addTestHook({
      registry,
      pluginId: "low-priority",
      hookName: "llm_output",
      priority: 1,
      handler: vi.fn().mockResolvedValue({ assistantTexts: ["low-priority text"] }),
    });

    const runner = createHookRunner(registry);
    const result = await runner.runLlmOutput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        assistantTexts: ["hi"],
        usage: { input: 10, output: 20, total: 30 },
      },
      { agentId: "main", sessionId: "session-1" },
    );

    expect(result).toEqual({ assistantTexts: ["high-priority text"] });
  });
});
