import { beforeEach, describe, expect, it } from "vitest";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("cron producer-owned final results", () => {
  setupRunCronIsolatedAgentTurnSuite();
  beforeEach(() => {
    mockRunCronFallbackPassthrough();
  });

  it.each([
    "On it, checking the report now.",
    "Both subagents are running. Wait for them to report back.",
    "No channel reply.",
  ])("does not infer a retry from visible final prose: %s", async (text) => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text }],
      meta: {
        terminalReply: { disposition: "visible", text },
        agentMeta: { usage: { input: 10, output: 20 } },
      },
    });
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());
    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a fatal structured failure despite ordinary final prose", async () => {
    const text = "On it, retrying now.";
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text }],
      meta: {
        terminalReply: { disposition: "visible", text },
        agentMeta: {},
        failureSignal: {
          kind: "execution_denied",
          source: "tool",
          toolName: "exec",
          code: "SYSTEM_RUN_DENIED",
          message: "SYSTEM_RUN_DENIED: approval required",
          fatalForCron: true,
        },
      },
    });
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());
    expect(result).toMatchObject({
      status: "error",
      error: "SYSTEM_RUN_DENIED: approval required",
    });
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
  });
});
