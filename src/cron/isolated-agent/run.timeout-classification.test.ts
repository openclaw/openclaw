import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — timeout classification", () => {
  setupRunCronIsolatedAgentTurnSuite();

  const mockFallbackPassthrough = () => {
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
  };

  it("does not classify matching timeout text as structured timeout without abort signal", async () => {
    runEmbeddedPiAgentMock.mockRejectedValueOnce(new Error("cron: job execution timed out"));
    mockFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("error");
    expect(result.error).toContain("cron: job execution timed out");
    expect(result.errorKind).toBeUndefined();
  });

  it("classifies aborted runs as structured timeout", async () => {
    const controller = new AbortController();
    controller.abort("cron: job execution timed out");
    mockFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({ abortSignal: controller.signal }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("cron: job execution timed out");
    expect(result.errorKind).toBe("isolated-runner-timeout");
  });
});
