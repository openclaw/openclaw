import { expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { FollowupRun } from "./queue.js";

const updateSessionEntry = vi.hoisted(() => vi.fn());
// mock-isolation: Exercise selection updates against the supplied session entry, not a live store.
vi.mock("../../config/sessions/session-accessor.js", () => ({ updateSessionEntry }));
import { clearRecoveredAutoFallbackPrimaryProbeSelection } from "./agent-runner-auto-fallback.js";

const primary = { provider: "anthropic", model: "claude-sonnet-4-6" };
const probe = { ...primary, fallbackProvider: "openai", fallbackModel: "gpt-5.4" };
const autoEntry: SessionEntry = {
  sessionId: "session",
  updatedAt: 1,
  providerOverride: probe.fallbackProvider,
  modelOverride: probe.fallbackModel,
  modelOverrideSource: "auto",
  modelOverrideFallbackOriginProvider: primary.provider,
  modelOverrideFallbackOriginModel: primary.model,
};

it.each(["newer user selection", "auto auth pin", "user auth pin"] as const)(
  "recovers a primary probe without overwriting %s",
  async (scenario) => {
    const rejected = scenario === "newer user selection";
    const authSource = scenario === "user auth pin" ? "user" : "auto";
    const entry = { ...autoEntry };
    const persisted: SessionEntry = rejected
      ? {
          sessionId: "newer-session",
          updatedAt: 2,
          providerOverride: "openai",
          modelOverride: "gpt-5.5",
          modelOverrideSource: "user",
        }
      : { ...entry, authProfileOverride: "openai:fallback", authProfileOverrideSource: authSource };
    const snapshot = { ...persisted };
    updateSessionEntry
      .mockReset()
      .mockImplementationOnce(
        async (
          _scope: unknown,
          update: (current: SessionEntry) => Partial<SessionEntry> | null,
        ) => {
          const patch = update(persisted);
          if (rejected) {
            expect(patch).toBeNull();
          }
          return patch && { ...persisted, ...patch };
        },
      );
    const activeSessionStore = { main: entry };
    await clearRecoveredAutoFallbackPrimaryProbeSelection({
      run: { ...primary, autoFallbackPrimaryProbe: probe } as FollowupRun["run"],
      ...primary,
      sessionKey: "main",
      activeSessionStore,
      getActiveSessionEntry: () => entry,
      storePath: "/tmp/sessions.sqlite",
    });
    if (rejected) {
      expect(activeSessionStore.main).toBe(persisted);
      expect(persisted).toEqual(snapshot);
    } else {
      expect(activeSessionStore.main).toMatchObject({
        modelOverride: undefined,
        providerOverride: undefined,
        authProfileOverride: authSource === "user" ? "openai:fallback" : undefined,
        authProfileOverrideSource: authSource === "user" ? "user" : undefined,
      });
    }
  },
);
