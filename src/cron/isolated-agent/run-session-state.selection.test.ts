import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { contextBudgetStatusFixture } from "../../config/sessions/context-budget.test-support.js";
import { syncCronSessionLiveSelection } from "./run-session-state.js";

function makeSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return { sessionId: "run-session-id", updatedAt: 1000, systemSent: true, ...overrides };
}

describe("syncCronSessionLiveSelection", () => {
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
