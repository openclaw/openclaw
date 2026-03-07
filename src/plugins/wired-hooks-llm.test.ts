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

  it("runLlmInput returns modified prompt from hook", async () => {
    const handler = vi.fn().mockResolvedValue({ prompt: "redacted prompt" });
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
        historyMessages: [],
        imagesCount: 0,
      },
      { agentId: "main", sessionId: "session-1" },
    );

    expect(result).toEqual(expect.objectContaining({ prompt: "redacted prompt" }));
  });

  it("runLlmInput returns undefined when hook returns void (backward compat)", async () => {
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
      { agentId: "main", sessionId: "session-1" },
    );

    expect(result).toBeUndefined();
  });

  it("runLlmOutput returns modified assistantTexts from hook", async () => {
    const handler = vi.fn().mockResolvedValue({ assistantTexts: ["rehydrated response"] });
    const registry = createMockPluginRegistry([{ hookName: "llm_output", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runLlmOutput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        assistantTexts: ["raw «PERSON_001» response"],
        lastAssistant: { role: "assistant", content: "raw" },
        usage: { input: 10, output: 20, total: 30 },
      },
      { agentId: "main", sessionId: "session-1" },
    );

    expect(result).toEqual(expect.objectContaining({ assistantTexts: ["rehydrated response"] }));
  });

  it("runLlmOutput returns undefined when hook returns void (backward compat)", async () => {
    const handler = vi.fn(); // returns undefined
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
});
