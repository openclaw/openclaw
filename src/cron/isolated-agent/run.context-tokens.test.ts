import { describe, expect, it } from "vitest";
import { makeIsolatedAgentTurnParams, setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  lookupContextTokensMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn context token lookup", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("disables async context-token loading when recording isolated-run telemetry", async () => {
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: {
          id: "cron-context-tokens",
          payload: {
            kind: "agentTurn",
            agentId: "default",
            message: "return a final answer",
          },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(lookupContextTokensMock).toHaveBeenCalledWith("gpt-4", { allowAsyncLoad: false });
  });
});
