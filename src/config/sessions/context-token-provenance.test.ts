import { expect, it } from "vitest";
import { contextBudgetStatusFixture } from "./context-budget.test-support.js";
import {
  resolveProjectedSessionContextTokens,
  resolveProjectedSessionContextBudgetStatus,
  resolveTrustedSessionContextTokens,
} from "./context-token-provenance.js";

const currentSelection = { provider: "openai", model: "gpt-5.6-sol", agentHarnessId: "codex" };
const matchingRuntimeEntry = {
  modelProvider: "openai",
  model: "gpt-5.6-sol",
  agentHarnessId: "codex",
  contextTokens: 272_000,
  contextTokensSource: "runtime" as const,
};
type Projection = Parameters<typeof resolveProjectedSessionContextTokens>[0];
const project = (entry: Projection["entry"], options: Partial<Projection> = {}) =>
  resolveProjectedSessionContextTokens({
    ...currentSelection,
    entry,
    resolvedContextTokens: undefined,
    ...options,
  });

it("rejects a locked window owned by a different model", () => {
  expect(
    resolveTrustedSessionContextTokens({
      entry: {
        modelProvider: "openai",
        model: "gpt-5.5",
        modelSelectionLocked: true,
        contextTokens: 272_000,
      },
      ...currentSelection,
    }),
  ).toBeUndefined();
});

it("falls back to current resolution when producer provenance differs", () => {
  expect(
    project(
      { ...matchingRuntimeEntry, agentHarnessId: "openclaw" },
      { resolvedContextTokens: 1_000_000 },
    ),
  ).toBe(1_000_000);
});

it("falls back to the matching persisted resolution while current resolution is unavailable", () => {
  expect(project({ ...matchingRuntimeEntry, contextTokensSource: "resolved-v1" })).toBe(272_000);
});

it("rejects a legacy resolved row because its producer may have reused a fallback", () => {
  expect(project({ ...matchingRuntimeEntry, contextTokensSource: "resolved" })).toBeUndefined();
});

it("rejects a persisted resolution owned by a different harness", () => {
  expect(
    project({
      ...matchingRuntimeEntry,
      contextTokensSource: "resolved-v1",
      agentHarnessId: "openclaw",
    }),
  ).toBeUndefined();
});

it("preserves a locked native window ahead of current configuration", () => {
  expect(
    project(
      { modelSelectionLocked: true, contextTokens: 1_000_000 },
      { resolvedContextTokens: 272_000, authoredContextTokens: 272_000 },
    ),
  ).toBe(1_000_000);
});

const entry = { sessionId: "session-1", contextBudgetStatus: contextBudgetStatusFixture() };
const selection = { provider: "ollama", model: "qwen3:8b", contextTokens: 200_000 };

it("rejects a budget after the lower cap changes", () => {
  expect(
    resolveProjectedSessionContextBudgetStatus({
      entry,
      ...selection,
      contextTokens: 100_000,
    }),
  ).toBeUndefined();
});

it("keeps a narrower budget owned by the serving runtime", () => {
  const runtimeEntry = {
    ...entry,
    modelProvider: "ollama",
    model: "qwen3:8b",
    agentHarnessId: "openclaw",
    contextTokens: 200_000,
    contextTokensSource: "runtime" as const,
  };
  const contextTokens = resolveProjectedSessionContextTokens({
    entry: runtimeEntry,
    ...selection,
    agentHarnessId: "openclaw",
    resolvedContextTokens: 262_144,
  });
  expect(contextTokens).toBe(200_000);
  expect(
    resolveProjectedSessionContextBudgetStatus({
      entry: runtimeEntry,
      ...selection,
      contextTokens,
    }),
  ).toEqual(entry.contextBudgetStatus);
});
