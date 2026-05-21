import { describe, expect, it } from "vitest";
import { resolveSessionContextBudgetPolicy } from "./context-budget-policy.js";
import type { SessionContextBudgetStatus } from "./types.js";

function makeStatus(patch: Partial<SessionContextBudgetStatus> = {}): SessionContextBudgetStatus {
  return {
    schemaVersion: 1,
    source: "pre-prompt-estimate",
    updatedAt: 1,
    provider: "anthropic",
    model: "claude-opus-4-6",
    route: "fits",
    shouldCompact: false,
    estimatedPromptTokens: 100,
    contextTokenBudget: 1_000,
    promptBudgetBeforeReserve: 900,
    reserveTokens: 100,
    effectiveReserveTokens: 100,
    remainingPromptBudgetTokens: 800,
    overflowTokens: 0,
    toolResultReducibleChars: 0,
    messageCount: 1,
    unwindowedMessageCount: 1,
    ...patch,
  };
}

describe("resolveSessionContextBudgetPolicy", () => {
  it("classifies low estimated prompt usage as safe", () => {
    expect(
      resolveSessionContextBudgetPolicy(
        makeStatus({
          estimatedPromptTokens: 125_000,
          contextTokenBudget: 1_000_000,
          promptBudgetBeforeReserve: 900_000,
          remainingPromptBudgetTokens: 775_000,
        }),
      ),
    ).toMatchObject({
      pressure: "safe",
      contextBudgetPct: 13,
      promptBudgetPct: 14,
      remainingPromptBudgetTokens: 775_000,
    });
  });

  it("classifies reserve-budget pressure before overflow", () => {
    expect(
      resolveSessionContextBudgetPolicy(
        makeStatus({
          estimatedPromptTokens: 640_000,
          contextTokenBudget: 1_000_000,
          promptBudgetBeforeReserve: 900_000,
          remainingPromptBudgetTokens: 260_000,
        }),
      ),
    ).toMatchObject({
      pressure: "watch",
      contextBudgetPct: 64,
      promptBudgetPct: 71,
    });

    expect(
      resolveSessionContextBudgetPolicy(
        makeStatus({
          estimatedPromptTokens: 780_000,
          contextTokenBudget: 1_000_000,
          promptBudgetBeforeReserve: 900_000,
          remainingPromptBudgetTokens: 120_000,
        }),
      )?.pressure,
    ).toBe("pressure");
  });

  it("classifies non-fitting precheck routes as overflow risk", () => {
    expect(
      resolveSessionContextBudgetPolicy(
        makeStatus({
          route: "compact_then_truncate",
          shouldCompact: true,
          estimatedPromptTokens: 920_000,
          contextTokenBudget: 1_000_000,
          promptBudgetBeforeReserve: 900_000,
          remainingPromptBudgetTokens: 0,
          overflowTokens: 20_000,
        }),
      )?.pressure,
    ).toBe("overflow-risk");
  });
});
