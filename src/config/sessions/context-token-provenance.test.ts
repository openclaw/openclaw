import { expect, it } from "vitest";
import { contextBudgetStatusFixture } from "./context-budget.test-support.js";
import {
  resolveProjectedSessionContextTokens,
  resolveProjectedSessionContextBudgetStatus,
  resolveTrustedSessionContextTokens,
} from "./context-token-provenance.js";

const selection = { provider: "openai", model: "gpt-5.6-sol", agentHarnessId: "codex" };
const runtime = {
  modelProvider: selection.provider,
  model: selection.model,
  agentHarnessId: selection.agentHarnessId,
  contextTokens: 272_000,
  contextTokensSource: "runtime" as const,
};

it("rejects a locked window owned by a different model", () => {
  expect(
    resolveTrustedSessionContextTokens({
      entry: {
        modelProvider: "openai",
        model: "gpt-5.5",
        modelSelectionLocked: true,
        contextTokens: 272_000,
      },
      ...selection,
    }),
  ).toBeUndefined();
});

it.each([
  [
    "current resolution for a different producer",
    { agentHarnessId: "openclaw" },
    1_000_000,
    1_000_000,
  ],
  ["matching persisted resolution", { contextTokensSource: "resolved-v1" }, undefined, 272_000],
  ["rejected legacy resolution", { contextTokensSource: "resolved" }, undefined, undefined],
  [
    "rejected resolution from another harness",
    { contextTokensSource: "resolved-v1", agentHarnessId: "openclaw" },
    undefined,
    undefined,
  ],
] as const)("projects %s", (_name, patch, resolvedContextTokens, expected) => {
  const result = resolveProjectedSessionContextTokens({
    ...selection,
    entry: { ...runtime, ...patch },
    resolvedContextTokens,
  });
  expect(result).toBe(expected);
});

it("preserves a locked native window ahead of current configuration", () => {
  expect(
    resolveProjectedSessionContextTokens({
      ...selection,
      entry: { modelSelectionLocked: true, contextTokens: 1_000_000 },
      resolvedContextTokens: 272_000,
      authoredContextTokens: 272_000,
    }),
  ).toBe(1_000_000);
});

const entry = { sessionId: "session-1", contextBudgetStatus: contextBudgetStatusFixture() };
const budgetSelection = { provider: "ollama", model: "qwen3:8b", contextTokens: 200_000 };

it("rejects a budget after the lower cap changes", () => {
  expect(
    resolveProjectedSessionContextBudgetStatus({
      entry,
      ...budgetSelection,
      contextTokens: 100_000,
    }),
  ).toBeUndefined();
});

it("keeps a narrower budget owned by the serving runtime", () => {
  const runtimeEntry = {
    ...entry,
    modelProvider: budgetSelection.provider,
    model: budgetSelection.model,
    agentHarnessId: "openclaw",
    contextTokens: 200_000,
    contextTokensSource: "runtime" as const,
  };
  const contextTokens = resolveProjectedSessionContextTokens({
    entry: runtimeEntry,
    ...budgetSelection,
    agentHarnessId: "openclaw",
    resolvedContextTokens: 262_144,
  });
  expect(contextTokens).toBe(200_000);
  expect(
    resolveProjectedSessionContextBudgetStatus({
      entry: runtimeEntry,
      ...budgetSelection,
      contextTokens,
    }),
  ).toEqual(entry.contextBudgetStatus);
});
