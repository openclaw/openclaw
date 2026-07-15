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

describe("clearRecoveredAutoFallbackPrimaryProbeSelection", () => {
  beforeEach(() => {
    state.updateSessionEntryMock.mockReset();
  });

  it("keeps the local probe selection when the persisted comparison rejects it", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5.4",
    };
    const staleAutoEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: probe.provider,
      modelOverrideFallbackOriginModel: probe.model,
    };
    const newerUserEntry: SessionEntry = {
      sessionId: "session",
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

    expect(activeSessionStore.main).toBe(staleAutoEntry);
    expect(activeSessionStore.main).toMatchObject({
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
      modelOverrideSource: "auto",
    });
  });
});
