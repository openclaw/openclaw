import { describe, expect, it } from "vitest";
import { contextBudgetStatusFixture } from "./context-budget.test-support.js";
import {
  resolveProjectedSessionContextTokenBudget,
  resolveProjectedSessionContextTokens,
  resolveProjectedSessionContextBudgetStatus,
  resolveTrustedSessionContextTokens,
} from "./context-token-provenance.js";
import type { SessionEntry } from "./types.js";

const currentSelection = {
  provider: "openai",
  model: "gpt-5.6-sol",
  agentHarnessId: "codex",
};

describe("resolveTrustedSessionContextTokens", () => {
  it("normalizes provider and harness but retains the exact producing model", () => {
    expect(
      resolveTrustedSessionContextTokens({
        entry: {
          modelProvider: "OpenAI",
          model: "gpt-5.6-sol",
          agentHarnessId: "Codex",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
        },
        ...currentSelection,
      }),
    ).toBe(272_000);
  });

  it.each([
    { name: "missing source", patch: { contextTokensSource: undefined } },
    { name: "resolved source", patch: { contextTokensSource: "resolved" as const } },
    {
      name: "runtime-configured source",
      patch: { contextTokensSource: "runtime-configured" as const },
    },
    { name: "missing harness", patch: { agentHarnessId: undefined } },
    { name: "different harness", patch: { agentHarnessId: "openclaw" } },
    { name: "different provider", patch: { modelProvider: "openrouter" } },
    { name: "different model", patch: { model: "gpt-5.5" } },
    { name: "case-distinct model", patch: { model: "GPT-5.6-SOL" } },
  ])("rejects $name", ({ patch }) => {
    expect(
      resolveTrustedSessionContextTokens({
        entry: {
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          agentHarnessId: "codex",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
          ...patch,
        },
        ...currentSelection,
      }),
    ).toBeUndefined();
  });

  it("preserves the native window owned by a locked legacy session", () => {
    expect(
      resolveTrustedSessionContextTokens({
        entry: {
          modelSelectionLocked: true,
          contextTokens: 272_000,
        },
        ...currentSelection,
      }),
    ).toBe(272_000);
  });

  it.each([
    { name: "provider", patch: { modelProvider: "openrouter" } },
    { name: "model", patch: { model: "gpt-5.5" } },
  ])("rejects a locked window owned by a different $name", ({ patch }) => {
    expect(
      resolveTrustedSessionContextTokens({
        entry: {
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          modelSelectionLocked: true,
          contextTokens: 272_000,
          ...patch,
        },
        ...currentSelection,
      }),
    ).toBeUndefined();
  });
});

describe("resolveProjectedSessionContextTokens", () => {
  const matchingRuntimeEntry = {
    modelProvider: "openai",
    model: "gpt-5.6-sol",
    agentHarnessId: "codex",
    contextTokens: 272_000,
    contextTokensSource: "runtime" as const,
  };

  it("uses an authored effective cap instead of older matching telemetry", () => {
    expect(
      resolveProjectedSessionContextTokens({
        entry: matchingRuntimeEntry,
        ...currentSelection,
        resolvedContextTokens: 1_000_000,
        authoredContextTokens: 1_000_000,
      }),
    ).toBe(1_000_000);
  });

  it("keeps matching runtime telemetry below a higher native window", () => {
    expect(
      resolveProjectedSessionContextTokens({
        entry: matchingRuntimeEntry,
        ...currentSelection,
        resolvedContextTokens: 1_000_000,
      }),
    ).toBe(272_000);
  });

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

  it("does not resurrect a removed runtime-configured cap while resolution is unavailable", () => {
    expect(
      resolveProjectedSessionContextTokens({
        entry: { ...matchingRuntimeEntry, contextTokensSource: "runtime-configured" },
        ...currentSelection,
        resolvedContextTokens: undefined,
      }),
    ).toBeUndefined();
  });

  it.each([
    { name: "provider", patch: { modelProvider: "openrouter" } },
    { name: "model", patch: { model: "gpt-5.5" } },
    { name: "harness", patch: { agentHarnessId: "openclaw" } },
  ])("rejects a persisted resolution owned by a different $name", ({ patch }) => {
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
  });

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

  it("keeps a last-run estimate with a matching cap", () => {
    expect(resolveProjectedSessionContextBudgetStatus({ entry, ...selection })).toEqual(
      entry.contextBudgetStatus,
    );
  });

  it.each([
    { name: "model", current: { model: "qwen3:4b" } },
    { name: "missing model", current: { model: undefined } },
    { name: "missing provider", current: { provider: undefined } },
    { name: "unknown cap", current: { contextTokens: undefined } },
    { name: "provider", current: { provider: "lmstudio" } },
    { name: "lower cap", current: { contextTokens: 100_000 } },
    { name: "higher cap", current: { contextTokens: 1_000_000 } },
  ])("rejects a budget after the $name changes", ({ current }) => {
    expect(
      resolveProjectedSessionContextBudgetStatus({ entry, ...selection, ...current }),
    ).toBeUndefined();
  });

  it.each([{ sessionId: "session-2" }, { liveModelSwitchPending: true }])(
    "rejects a stale session lifecycle %j",
    (patch) => {
      expect(
        resolveProjectedSessionContextBudgetStatus({ entry: { ...entry, ...patch }, ...selection }),
      ).toBeUndefined();
    },
  );

  it.each([undefined, " "])("rejects an unbound snapshot session ID %j", (sessionId) => {
    expect(
      resolveProjectedSessionContextBudgetStatus({
        entry: { ...entry, contextBudgetStatus: { ...entry.contextBudgetStatus, sessionId } },
        ...selection,
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
});

describe("source-bearing synthetic fallback budgets", () => {
  const producer = {
    modelProvider: "openai",
    model: "gpt-5.6-sol",
    agentHarnessId: "codex",
  };
  const cases: Array<{
    name: string;
    entry?: Pick<
      SessionEntry,
      | "modelProvider"
      | "model"
      | "agentHarnessId"
      | "contextTokens"
      | "contextTokensSource"
      | "modelSelectionLocked"
    >;
    authoredContextTokens?: number;
    contextTokens: number;
    contextTokensSource: SessionEntry["contextTokensSource"];
  }> = [
    { name: "unreported owner", contextTokens: 128_000, contextTokensSource: "synthetic" },
    {
      name: "authored budget",
      authoredContextTokens: 200_000,
      contextTokens: 200_000,
      contextTokensSource: "resolved",
    },
    {
      name: "matching runtime",
      entry: { ...producer, contextTokens: 272_000, contextTokensSource: "runtime" },
      contextTokens: 272_000,
      contextTokensSource: "runtime",
    },
    {
      name: "matching effective resolution",
      entry: { ...producer, contextTokens: 272_000, contextTokensSource: "resolved-v1" },
      contextTokens: 272_000,
      contextTokensSource: "resolved-v1",
    },
    {
      name: "locked native window",
      entry: { ...producer, contextTokens: 272_000, modelSelectionLocked: true },
      contextTokens: 272_000,
      contextTokensSource: undefined,
    },
  ];
  it.each(cases)(
    "preserves $name authority over an estimated window",
    ({ entry, authoredContextTokens, contextTokens, contextTokensSource }) => {
      expect(
        resolveProjectedSessionContextTokenBudget({
          entry,
          ...currentSelection,
          resolvedContextTokens: 128_000,
          resolvedContextTokensSource: "synthetic",
          configuredContextTokenLimits: {
            effectiveConfiguredTokens: authoredContextTokens,
            authoredContextTokenCap: authoredContextTokens,
          },
        }),
      ).toEqual({ contextTokens, contextTokensSource });
    },
  );
});
