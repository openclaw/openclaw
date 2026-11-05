import { expect, it } from "vitest";
import { contextBudgetStatusFixture } from "../config/sessions/context-budget.test-support.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import { buildStatusMessage, statusModelRefs } from "./status-message.test-support.js";

it("keeps measured zero counters instead of hydrating historical transcript totals", () => {
  const text = buildStatusMessage({
    agent: { model: "ollama/llama3.2" },
    modelRefs: statusModelRefs({ provider: "ollama", model: "llama3.2" }),
    transcriptUsage: {
      inputTokens: 9000,
      outputTokens: 100,
      totalTokens: 9000,
      totalTokensFresh: true,
    },
    sessionEntry: {
      sessionId: "measured-zero",
      updatedAt: 0,
      usageReport: { state: "available" },
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    },
  });
  expect(text).toContain("Tokens: 0 in / 0 out");
  expect(text).toContain("Context: 0/");
});

it("shows measured zero from prepared transcript facts when session counters are missing", () => {
  const text = buildStatusMessage({
    agent: { model: "ollama/llama3.2" },
    modelRefs: statusModelRefs({ provider: "ollama", model: "llama3.2" }),
    transcriptUsage: {
      usageReport: { state: "available" },
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalTokensFresh: true,
    },
    sessionEntry: {
      sessionId: "transcript-zero",
      updatedAt: 0,
      contextBudgetStatus: contextBudgetStatusFixture({
        updatedAt: 1,
        model: "llama3.2",
        estimatedPromptTokens: 4096,
        contextTokenBudget: 32768,
        promptBudgetBeforeReserve: 30000,
        reserveTokens: 2768,
        effectiveReserveTokens: 2768,
        remainingPromptBudgetTokens: 25904,
        messageCount: 1,
        unwindowedMessageCount: 1,
        sessionId: "transcript-zero",
      }),
    },
  });
  expect(text).toContain("Tokens: 0 in / 0 out");
  expect(text).toContain("Context: 0/");
});

it.each(["session", "transcript"] as const)(
  "shows interrupted %s usage as unavailable instead of reusing prior counters or price",
  (source) => {
    const text = buildStatusMessage({
      agent: { model: "ollama/llama3.2" },
      modelRefs: statusModelRefs({ provider: "ollama", model: "llama3.2" }),
      transcriptUsage:
        source === "transcript" ? { usageReport: { state: "unavailable" } } : undefined,
      sessionEntry: {
        sessionId: "status",
        updatedAt: 0,
        ...(source === "session" ? { usageReport: { state: "unavailable" as const } } : {}),
        inputTokens: 123,
        outputTokens: 45,
        estimatedCostUsd: 0.5,
        totalTokensFresh: false,
      },
    });
    expect(text).toContain("Tokens: unavailable (incomplete response)");
    expect(text).not.toContain("123 in / 45 out");
    expect(text).not.toContain("Cost:");
  },
);
