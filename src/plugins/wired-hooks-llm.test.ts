import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";

const hookCtx = {
  agentId: "main",
  sessionId: "session-1",
};

async function expectHookCall(params: {
  hookName: "llm_input" | "llm_output" | "before_model_call" | "after_model_call";
  event: Record<string, unknown>;
  expectedEvent: Record<string, unknown>;
}) {
  const handler = vi.fn();
  const { runner } = createHookRunnerWithRegistry([{ hookName: params.hookName, handler }]);

  if (params.hookName === "llm_input") {
    await runner.runLlmInput(
      {
        ...params.event,
        historyMessages: [...((params.event.historyMessages as unknown[] | undefined) ?? [])],
      } as Parameters<typeof runner.runLlmInput>[0],
      hookCtx,
    );
  } else if (params.hookName === "llm_output") {
    await runner.runLlmOutput(
      {
        ...params.event,
        assistantTexts: [...((params.event.assistantTexts as string[] | undefined) ?? [])],
      } as Parameters<typeof runner.runLlmOutput>[0],
      hookCtx,
    );
  } else if (params.hookName === "before_model_call") {
    await runner.runBeforeModelCall(
      {
        ...params.event,
        requestMessages: [...((params.event.requestMessages as unknown[] | undefined) ?? [])],
      } as Parameters<typeof runner.runBeforeModelCall>[0],
      hookCtx,
    );
  } else {
    await runner.runAfterModelCall(
      params.event as Parameters<typeof runner.runAfterModelCall>[0],
      hookCtx,
    );
  }

  expect(handler).toHaveBeenCalledWith(
    expect.objectContaining(params.expectedEvent),
    expect.objectContaining({ sessionId: "session-1" }),
  );
}

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
    {
      name: "runBeforeModelCall invokes registered before_model_call hooks",
      hookName: "before_model_call" as const,
      event: {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5.4",
        api: "openai-chat",
        callId: "run-1-1",
        systemPrompt: "be helpful",
        requestMessages: [{ role: "user", content: "hello" }],
      },
      expectedEvent: {
        runId: "run-1",
        callId: "run-1-1",
        requestMessages: [{ role: "user", content: "hello" }],
      },
    },
    {
      name: "runAfterModelCall invokes registered after_model_call hooks",
      hookName: "after_model_call" as const,
      event: {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5.4",
        api: "openai-chat",
        callId: "run-1-1",
        durationMs: 12,
        responseMessage: { role: "assistant", content: "hi" },
      },
      expectedEvent: {
        runId: "run-1",
        callId: "run-1-1",
        responseMessage: { role: "assistant", content: "hi" },
      },
    },
  ] as const)("$name", async ({ hookName, expectedEvent, event }) => {
    await expectHookCall({ hookName, event, expectedEvent });
  });

  it("hasHooks returns true for registered llm hooks", () => {
    const { runner } = createHookRunnerWithRegistry([{ hookName: "llm_input", handler: vi.fn() }]);

    expect(runner.hasHooks("llm_input")).toBe(true);
    expect(runner.hasHooks("llm_output")).toBe(false);
  });

  it("hasHooks returns true for registered model call hooks", () => {
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "before_model_call", handler: vi.fn() },
    ]);

    expect(runner.hasHooks("before_model_call")).toBe(true);
    expect(runner.hasHooks("after_model_call")).toBe(false);
  });
});
