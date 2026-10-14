import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { FollowupRun } from "./queue.js";

const state = vi.hoisted(() => ({
  updateSessionEntryMock: vi.fn(),
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  updateSessionEntry: (...args: unknown[]) => state.updateSessionEntryMock(...args),
}));

import { clearRecoveredAutoFallbackPrimaryProbeSelection } from "./agent-runner-auto-fallback.js";

const probe = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  fallbackProvider: "openai",
  fallbackModel: "gpt-5.4",
};

function createAutoEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session",
    updatedAt: 1,
    providerOverride: probe.fallbackProvider,
    modelOverride: probe.fallbackModel,
    modelOverrideSource: "auto",
    modelOverrideFallbackOriginProvider: probe.provider,
    modelOverrideFallbackOriginModel: probe.model,
    ...overrides,
  };
}

async function clearProbe(
  activeSessionStore: Record<string, SessionEntry>,
  staleAutoEntry: SessionEntry,
) {
  await clearRecoveredAutoFallbackPrimaryProbeSelection({
    run: {
      provider: probe.provider,
      model: probe.model,
      autoFallbackPrimaryProbe: probe,
    } as FollowupRun["run"],
    provider: probe.provider,
    model: probe.model,
    sessionKey: "main",
    activeSessionStore,
    getActiveSessionEntry: () => staleAutoEntry,
    storePath: "/tmp/sessions.sqlite",
  });
}

describe("clearRecoveredAutoFallbackPrimaryProbeSelection", () => {
  beforeEach(() => {
    state.updateSessionEntryMock.mockReset();
  });

  it("refreshes the local selection when the persisted comparison rejects the probe", async () => {
    const staleAutoEntry = createAutoEntry();
    const newerUserEntry: SessionEntry = {
      sessionId: "newer-session",
      updatedAt: 2,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
    };
    const activeSessionStore = { main: staleAutoEntry };
    state.updateSessionEntryMock.mockImplementationOnce(
      async (_scope: unknown, update: (entry: SessionEntry) => unknown) => {
        expect(await update(newerUserEntry)).toBeNull();
        return null;
      },
    );

    await clearProbe(activeSessionStore, staleAutoEntry);

    expect(activeSessionStore.main).toBe(newerUserEntry);
    expect(activeSessionStore.main).toMatchObject({
      sessionId: "newer-session",
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
    });
  });

  it.each(["auto", "user"] as const)(
    "clears recovered model selection while respecting an %s auth pin",
    async (authSource) => {
      const entry = createAutoEntry({
        authProfileOverride: "openai:fallback",
        authProfileOverrideSource: authSource,
      });
      const activeSessionStore = { main: entry };
      state.updateSessionEntryMock.mockImplementationOnce(
        async (_scope: unknown, update: (entry: SessionEntry) => Partial<SessionEntry>) => {
          const persisted = { ...entry };
          return { ...persisted, ...update(persisted) };
        },
      );

      await clearProbe(activeSessionStore, entry);

      expect(activeSessionStore.main.modelOverride).toBeUndefined();
      expect(activeSessionStore.main.providerOverride).toBeUndefined();
      expect(activeSessionStore.main.authProfileOverride).toBe(
        authSource === "user" ? "openai:fallback" : undefined,
      );
      expect(activeSessionStore.main.authProfileOverrideSource).toBe(
        authSource === "user" ? "user" : undefined,
      );
    },
  );
});
