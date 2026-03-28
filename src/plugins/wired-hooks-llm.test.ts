import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

const hookCtx = {
  agentId: "main",
  sessionId: "session-1",
};

describe("llm hook runner methods", () => {
  it.each([
    {
      name: "runLlmInput invokes registered llm_input hooks",
      hookName: "llm_input" as const,
      methodName: "runLlmInput" as const,
      event: {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        systemPrompt: "be helpful",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      expectedEvent: { runId: "run-1", prompt: "hello" },
    },
    {
      name: "runLlmOutput invokes registered llm_output hooks",
      hookName: "llm_output" as const,
      methodName: "runLlmOutput" as const,
      event: {
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
      expectedEvent: { runId: "run-1", assistantTexts: ["hi"] },
    },
  ] as const)("$name", async ({ hookName, methodName, event, expectedEvent }) => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName, handler }]);
    const runner = createHookRunner(registry);

    if (methodName === "runLlmInput") {
      await runner.runLlmInput(
        {
          ...event,
          historyMessages: [...event.historyMessages],
        },
        hookCtx,
      );
    } else {
      await runner.runLlmOutput(
        {
          ...event,
          assistantTexts: [...event.assistantTexts],
        },
        hookCtx,
      );
    }

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining(expectedEvent),
      expect.objectContaining({ sessionId: "session-1" }),
    );
  });

  it("hasHooks returns true for registered llm hooks", () => {
    const registry = createMockPluginRegistry([{ hookName: "llm_input", handler: vi.fn() }]);
    const runner = createHookRunner(registry);

    expect(runner.hasHooks("llm_input")).toBe(true);
    expect(runner.hasHooks("llm_output")).toBe(false);
  });
});
