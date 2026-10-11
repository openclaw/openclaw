import { describe, expect, it } from "vitest";
import { contextBudgetStatusFixture } from "./context-budget.test-support.js";
import {
  resolveProjectedSessionContextTokens,
  resolveProjectedSessionContextBudgetStatus,
  resolveTrustedSessionContextTokens,
} from "./context-token-provenance.js";

const currentSelection = {
  provider: "openai",
  model: "gpt-5.6-sol",
  agentHarnessId: "codex",
};

describe("resolveTrustedSessionContextTokens", () => {
  it.each([{ name: "model", patch: { model: "gpt-5.5" } }])(
    "rejects a locked window owned by a different $name",
    ({ patch }) => {
      expect(
        resolveTrustedSessionContextTokens({
          entry: {
            modelProvider: "openai",
            modelSelectionLocked: true,
            contextTokens: 272_000,
            ...patch,
          },
          ...currentSelection,
        }),
      ).toBeUndefined();
    },
  );
});

describe("resolveProjectedSessionContextTokens", () => {
  const matchingRuntimeEntry = {
    modelProvider: "openai",
    model: "gpt-5.6-sol",
    agentHarnessId: "codex",
    contextTokens: 272_000,
    contextTokensSource: "runtime" as const,
  };

  it("falls back to current resolution when producer provenance differs", () => {
    expect(
      resolveProjectedSessionContextTokens({
        entry: { ...matchingRuntimeEntry, agentHarnessId: "openclaw" },
        ...currentSelection,
        resolvedContextTokens: 1_000_000,
      }),
    ).toBe(1_000_000);
  });

  it("falls back to the matching persisted resolution while current resolution is unavailable", () => {
    expect(
      resolveProjectedSessionContextTokens({
        entry: { ...matchingRuntimeEntry, contextTokensSource: "resolved-v1" },
        ...currentSelection,
        resolvedContextTokens: undefined,
      }),
    ).toBe(272_000);
  });

  it("rejects a legacy resolved row because its producer may have reused a fallback", () => {
    expect(
      resolveProjectedSessionContextTokens({
        entry: { ...matchingRuntimeEntry, contextTokensSource: "resolved" },
        ...currentSelection,
        resolvedContextTokens: undefined,
      }),
    ).toBeUndefined();
  });

  it.each([{ name: "harness", patch: { agentHarnessId: "openclaw" } }])(
    "rejects a persisted resolution owned by a different $name",
    ({ patch }) => {
      expect(
        resolveProjectedSessionContextTokens({
          entry: {
            ...matchingRuntimeEntry,
            contextTokensSource: "resolved-v1",
            ...patch,
          },
          ...currentSelection,
          resolvedContextTokens: undefined,
        }),
      ).toBeUndefined();
    },
  );

  it("preserves a locked native window ahead of current configuration", () => {
    expect(
      resolveProjectedSessionContextTokens({
        entry: {
          modelSelectionLocked: true,
          contextTokens: 1_000_000,
        },
        ...currentSelection,
        resolvedContextTokens: 272_000,
        authoredContextTokens: 272_000,
      }),
    ).toBe(1_000_000);
  });
});

describe("resolveProjectedSessionContextBudgetStatus", () => {
  const entry = { sessionId: "session-1", contextBudgetStatus: contextBudgetStatusFixture() };
  const selection = { provider: "ollama", model: "qwen3:8b", contextTokens: 200_000 };

  it.each([{ name: "lower cap", current: { contextTokens: 100_000 } }])(
    "rejects a budget after the $name changes",
    ({ current }) => {
      expect(
        resolveProjectedSessionContextBudgetStatus({ entry, ...selection, ...current }),
      ).toBeUndefined();
    },
  );

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
});
