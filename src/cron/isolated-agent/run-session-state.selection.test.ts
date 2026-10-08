import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { contextBudgetStatusFixture } from "../../config/sessions/context-budget.test-support.js";
import { setCronSessionRuntimeModel, syncCronSessionLiveSelection } from "./run-session-state.js";

function makeSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return { sessionId: "run-session-id", updatedAt: 1000, systemSent: true, ...overrides };
}

describe("setCronSessionRuntimeModel", () => {
  it("clears model-derived state when the selected model changes", () => {
    const entry = makeSessionEntry({
      modelProvider: "openai",
      model: "gpt-5.3",
      contextTokens: 272_000,
      contextTokensSource: "runtime",
      contextBudgetStatus: contextBudgetStatusFixture({ contextTokenBudget: 272_000 }),
    });

    setCronSessionRuntimeModel({ entry, provider: "openai", model: "gpt-5.4" });

    expect(entry.modelProvider).toBe("openai");
    expect(entry.model).toBe("gpt-5.4");
    expect(entry.contextTokens).toBeUndefined();
    expect(entry.contextTokensSource).toBeUndefined();
    expect(entry.contextBudgetStatus).toBeUndefined();
  });

  it("preserves model-derived state when the selected model is unchanged", () => {
    const contextBudgetStatus = contextBudgetStatusFixture({ contextTokenBudget: 272_000 });
    const entry = makeSessionEntry({
      modelProvider: "openai",
      model: "gpt-5.4",
      contextTokens: 272_000,
      contextTokensSource: "runtime",
      contextBudgetStatus,
    });

    setCronSessionRuntimeModel({ entry, provider: "openai", model: "gpt-5.4" });

    expect(entry.contextTokens).toBe(272_000);
    expect(entry.contextTokensSource).toBe("runtime");
    expect(entry.contextBudgetStatus).toBe(contextBudgetStatus);
  });
});

describe("syncCronSessionLiveSelection", () => {
  it("clears model-derived state when only the agent runtime changes", () => {
    const entry = makeSessionEntry({
      modelProvider: "openai",
      model: "gpt-5.6-luna",
      agentRuntimeOverride: "openclaw",
      contextTokens: 272_000,
      contextTokensSource: "runtime",
      contextBudgetStatus: contextBudgetStatusFixture({ contextTokenBudget: 272_000 }),
    });

    syncCronSessionLiveSelection({
      entry,
      liveSelection: {
        provider: "openai",
        model: "gpt-5.6-luna",
        agentRuntimeOverride: "codex",
      },
    });

    expect(entry.agentRuntimeOverride).toBe("codex");
    expect(entry.contextTokens).toBeUndefined();
    expect(entry.contextTokensSource).toBeUndefined();
    expect(entry.contextBudgetStatus).toBeUndefined();
  });

  it("stamps a source-less live profile as a user pin", () => {
    const entry = makeSessionEntry({
      compactionCount: 4,
      authProfileOverrideCompactionCount: 2,
    });

    syncCronSessionLiveSelection({
      entry,
      liveSelection: {
        provider: "openai",
        model: "gpt-5.4",
        authProfileId: "openai:work",
      },
    });

    expect(entry.authProfileOverride).toBe("openai:work");
    expect(entry.authProfileOverrideSource).toBe("user");
    expect(entry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it.each([
    { name: "account rotation", profile: "openai:fallback", locked: false, retained: false },
    { name: "account removal", profile: undefined, locked: false, retained: false },
    { name: "same account promotion", profile: "openai:previous", locked: false, retained: true },
    { name: "locked native rotation", profile: "openai:fallback", locked: true, retained: true },
  ])("qualifies the current context on $name", ({ profile, locked, retained }) => {
    const entry = makeSessionEntry({
      modelProvider: "openai",
      model: "gpt-5.4",
      agentRuntimeOverride: locked ? "codex" : "openclaw",
      agentHarnessId: locked ? "codex" : "openclaw",
      modelSelectionLocked: locked,
      authProfileOverride: "openai:previous",
      compactionCount: 4,
      contextTokens: 888_000,
      contextTokensSource: "resolved-v1",
      contextBudgetStatus: contextBudgetStatusFixture({ contextTokenBudget: 888_000 }),
    });

    syncCronSessionLiveSelection({
      entry,
      liveSelection: {
        provider: "openai",
        model: "gpt-5.4",
        agentRuntimeOverride: locked ? "codex" : "openclaw",
        authProfileId: profile,
        authProfileIdSource: "auto",
      },
    });

    expect(entry.authProfileOverride).toBe(profile);
    expect(entry.authProfileOverrideSource).toBe(profile ? "auto" : undefined);
    expect(entry.authProfileOverrideCompactionCount).toBe(profile ? 4 : undefined);
    expect(entry.contextTokens).toBe(retained ? 888_000 : undefined);
    expect(entry.contextTokensSource).toBe(retained ? "resolved-v1" : undefined);
    expect(entry.contextBudgetStatus?.contextTokenBudget).toBe(retained ? 888_000 : undefined);
  });

  it("retains legacy automatic provenance for the same live profile", () => {
    const entry = makeSessionEntry({
      modelProvider: "openai",
      model: "gpt-5.4",
      agentRuntimeOverride: "openclaw",
      agentHarnessId: "openclaw",
      contextTokens: 888_000,
      contextTokensSource: "resolved-v1",
      compactionCount: 4,
      authProfileOverride: "openai:fallback",
      authProfileOverrideCompactionCount: 2,
    });

    syncCronSessionLiveSelection({
      entry,
      liveSelection: {
        provider: "openai",
        model: "gpt-5.4",
        authProfileId: "openai:fallback",
        agentRuntimeOverride: "openclaw",
      },
    });

    expect(entry.authProfileOverrideSource).toBe("auto");
    expect(entry.authProfileOverrideCompactionCount).toBe(4);
    expect(entry.contextTokens).toBe(888_000);
    expect(entry.contextTokensSource).toBe("resolved-v1");
  });
});
