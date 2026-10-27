import { expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";

const base = { runId: "run-1", sessionId: "session-1", provider: "openai", model: "gpt-5" };
const input = {
  ...base,
  systemPrompt: "be helpful",
  prompt: "PRIVATE_INPUT",
  historyMessages: [],
  imagesCount: 0,
  tools: [],
};
const output = {
  ...base,
  assistantTexts: ["PRIVATE_OUTPUT"],
  lastAssistant: { role: "assistant", content: "PRIVATE_OUTPUT" },
  usage: { input: 10, output: 20, total: 30 },
};

it.each([
  "main",
  "dashboard:incognito-test",
  "subagent:incognito-test",
  "internal-session-effects:incognito-test",
])("gates conversation observers but preserves terminal lifecycle for %s", async (session) => {
  const privateSession = session !== "main";
  const llmInput = vi.fn();
  const llmOutput = vi.fn();
  const agentEnd = vi.fn();
  const { runner } = createHookRunnerWithRegistry([
    { hookName: "llm_input", handler: llmInput },
    { hookName: "llm_output", handler: llmOutput },
    { hookName: "agent_end", handler: agentEnd },
  ]);
  const context = {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: `agent:main:${session}`,
    runId: "run-1",
  };
  await runner.runLlmInput({ ...input, historyMessages: [...input.historyMessages] }, context);
  await runner.runLlmOutput({ ...output, assistantTexts: [...output.assistantTexts] }, context);
  if (!privateSession) {
    expect(llmInput).toHaveBeenCalledWith(input, context);
    expect(llmOutput).toHaveBeenCalledWith(output, context);
    return;
  }
  expect(llmInput).not.toHaveBeenCalled();
  expect(llmOutput).not.toHaveBeenCalled();
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
  expect(agentEnd).toHaveBeenCalledExactlyOnceWith(
    { runId: "run-1", messages: [], success: false, durationMs: 42 },
    context,
  );
  expect(readMessages).not.toHaveBeenCalled();
  expect(readError).not.toHaveBeenCalled();
});

it("preserves Incognito policy order and fail-closed behavior", async () => {
  const calls: string[] = [];
  const { runner } = createHookRunnerWithRegistry(
    ["first", "second"].map((name, index) => ({
      hookName: "before_tool_call",
      priority: 10 - index * 5,
      handler: () => {
        calls.push(name);
        if (name === "second") {
          throw new Error("policy unavailable");
        }
      },
    })),
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
