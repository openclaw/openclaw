// Covers the cron result-level fallback outcome tracking: when
// runWithModelFallback returns outcome "exhausted" (all candidates failed), the
// execution result carries fallbackOutcome so consumers can distinguish "tried
// all fallbacks, none worked" from "primary-only error without fallback attempt".
import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentJobFixture,
  makeIsolatedAgentParamsFixture,
} from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn ? fallback outcome tracking", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("records fallbackOutcome as undefined when the first candidate succeeds", async () => {
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.fallbackOutcome).toBeUndefined();
  });

  it("records fallbackOutcome === "exhausted" when all fallback candidates fail", async () => {
    runWithModelFallbackMock.mockImplementation(
      async () => ({
        outcome: "exhausted",
        result: {
          payloads: [{ text: "All models failed.", isError: true }],
          meta: {
            agentMeta: {},
            error: {
              kind: "incomplete_turn",
              message: "All fallback candidates exhausted.",
              fallbackSafe: true,
            },
          },
        },
        provider: "openai",
        model: "gpt-4.1",
        attempts: [],
      }),
    );

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.fallbackOutcome).toBe("exhausted");
  });
});
