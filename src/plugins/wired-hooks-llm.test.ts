import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";

const hookCtx = { agentId: "main", sessionId: "session-1" };
const baseEvent = { runId: "run-1", sessionId: "session-1", provider: "openai", model: "gpt-5" };

describe("llm hook runner methods", () => {
  it("runModelCallStarted invokes registered model_call_started hooks", async () => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([{ hookName: "model_call_started", handler }]);
    const event = { ...baseEvent, callId: "call-1", api: "openai-responses", transport: "http" };

    await runner.runModelCallStarted(event, hookCtx);

    expect(handler).toHaveBeenCalledWith(event, hookCtx);
  });

  it("runModelCallEnded invokes registered model_call_ended hooks", async () => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([{ hookName: "model_call_ended", handler }]);
    const event = {
      ...baseEvent,
      callId: "call-1",
      durationMs: 42,
      outcome: "error" as const,
      errorCategory: "TimeoutError",
      upstreamRequestIdHash: "sha256:abcdef123456",
    };

    await runner.runModelCallEnded(event, hookCtx);

    expect(handler).toHaveBeenCalledWith(event, hookCtx);
  });

  it("runLlmInput invokes registered llm_input hooks", async () => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([{ hookName: "llm_input", handler }]);
    const event = {
      ...baseEvent,
      systemPrompt: "be helpful",
      prompt: "hello",
      historyMessages: [],
      imagesCount: 0,
      tools: [],
    };

    await runner.runLlmInput({ ...event, historyMessages: [...event.historyMessages] }, hookCtx);

    expect(handler).toHaveBeenCalledWith(event, hookCtx);
  });

  it("runLlmOutput invokes registered llm_output hooks", async () => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([{ hookName: "llm_output", handler }]);
    const event = {
      ...baseEvent,
      assistantTexts: ["hi"],
      lastAssistant: { role: "assistant", content: "hi" },
      usage: { input: 10, output: 20, total: 30 },
    };

    await runner.runLlmOutput({ ...event, assistantTexts: [...event.assistantTexts] }, hookCtx);

    expect(handler).toHaveBeenCalledWith(event, hookCtx);
  });
});

describe("Incognito observation hooks", () => {
  it.each(["dashboard", "subagent", "internal-session-effects"])(
    "withholds %s conversation content while preserving terminal lifecycle hooks",
    async (kind) => {
      const llmInput = vi.fn();
      const llmOutput = vi.fn();
      const agentEnd = vi.fn();
      const { runner } = createHookRunnerWithRegistry([
        { hookName: "llm_input", handler: llmInput },
        { hookName: "llm_output", handler: llmOutput },
        { hookName: "agent_end", handler: agentEnd },
      ]);
      const context = {
        ...hookCtx,
        sessionKey: `agent:main:${kind}:incognito-test`,
        runId: "run-1",
      };
      const identity = {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
      };
      await runner.runLlmInput(
        { ...identity, prompt: "PRIVATE_INPUT", historyMessages: [], imagesCount: 0 },
        context,
      );
      await runner.runLlmOutput({ ...identity, assistantTexts: ["PRIVATE_OUTPUT"] }, context);
      const readMessages = vi.fn(() => [{ role: "user", content: "PRIVATE_INPUT" }]);
      const readError = vi.fn(() => "PRIVATE_ERROR");
      await runner.runAgentEnd(
        {
          get messages() {
            return readMessages();
          },
          get error() {
            return readError();
          },
          success: false,
          durationMs: 42,
        },
        context,
      );
      expect(llmInput).not.toHaveBeenCalled();
      expect(llmOutput).not.toHaveBeenCalled();
      expect(agentEnd).toHaveBeenCalledExactlyOnceWith(
        { runId: "run-1", messages: [], success: false, durationMs: 42 },
        context,
      );
      expect(readMessages).not.toHaveBeenCalled();
      expect(readError).not.toHaveBeenCalled();
    },
  );

  it("preserves Incognito policy order and fail-closed behavior", async () => {
    const calls: string[] = [];
    const { runner } = createHookRunnerWithRegistry(
      [
        {
          hookName: "before_tool_call",
          priority: 10,
          handler: () => {
            calls.push("first");
          },
        },
        {
          hookName: "before_tool_call",
          priority: 5,
          handler: () => {
            calls.push("second");
            throw new Error("policy unavailable");
          },
        },
      ],
      { failurePolicyByHook: { before_tool_call: "fail-closed" } },
    );
    await expect(
      runner.runBeforeToolCall(
        { toolName: "exec", params: { command: "echo private" } },
        { sessionKey: "agent:main:dashboard:incognito-test", toolName: "exec" },
      ),
    ).rejects.toThrow("policy unavailable");
    expect(calls).toEqual(["first", "second"]);
  });
});
