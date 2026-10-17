import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resolveDirectStoredModelOverride,
  resolveStoredModelOverride,
  resolveStoredModelOverrideAsync,
} from "./stored-model-overrides.js";

function makeEntry(fields: Partial<SessionEntry>): SessionEntry {
  return { sessionId: "session", updatedAt: 1, ...fields };
}

const staleDefault = makeEntry({
  modelOverrideSource: "default",
  providerOverride: "anthropic",
  modelOverride: "stale-model",
});
const userPin = {
  providerOverride: "anthropic",
  modelOverride: "claude-sonnet-4-6",
  modelOverrideSource: "user" as const,
};
const automatic = {
  providerOverride: "google-vertex",
  modelOverride: "gemini-fallback",
  modelOverrideSource: "auto" as const,
};
const fallback = {
  ...automatic,
  modelOverrideFallbackOriginProvider: "openai",
  modelOverrideFallbackOriginModel: "gpt-primary",
};

function parentChoice(provider: string, model: string) {
  return { provider, model, source: "parent", routeResolution: "raw" };
}

function resolveParentOverride(parent: Partial<SessionEntry>) {
  const parentKey = "agent:main:discord:channel:root";
  return resolveStoredModelOverrideAsync({
    defaultProvider: "openai",
    sessionKey: `${parentKey}:thread:child`,
    sessionStore: { [parentKey]: makeEntry(parent) },
  });
}

describe("resolveStoredModelOverride", () => {
  it("recovers resolved provenance for legacy auto-fallback overrides", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionEntry: makeEntry({
          providerOverride: "cloudflare-ai-gateway",
          modelOverride: "gemini-2.5-flash-lite",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "anthropic",
          modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
        }),
      }),
    ).toMatchObject({ routeResolution: "resolved" });
  });

  it("awaits parent overrides without requiring a whole session store", async () => {
    const loadSessionEntry = vi.fn(async (sessionKey: string) =>
      sessionKey === "agent:main:telegram:dm:parent"
        ? makeEntry({
            providerOverride: "anthropic",
            modelOverride: "claude-sonnet-4-7",
          })
        : undefined,
    );

    expect(
      await resolveStoredModelOverrideAsync({
        defaultProvider: "openai",
        loadSessionEntry,
        sessionKey: "agent:main:telegram:dm:parent:thread:child",
      }),
    ).toEqual(parentChoice("anthropic", "claude-sonnet-4-7"));
    expect(loadSessionEntry).toHaveBeenCalledWith("agent:main:telegram:dm:parent");
  });

  it("does not inherit active automatic fallback overrides from parent sessions", async () => {
    expect(await resolveParentOverride(fallback)).toBeNull();
  });

  it("inherits configured automatic selections without fallback provenance", async () => {
    expect(await resolveParentOverride(automatic)).toEqual(
      parentChoice("google-vertex", "gemini-fallback"),
    );
  });

  it("rejects stale direct fields behind an explicit Default marker", () => {
    expect(
      resolveDirectStoredModelOverride({
        defaultProvider: "openai",
        sessionEntry: staleDefault,
      }),
    ).toBeNull();
  });

  it("does not inherit stale fields from a parent that explicitly selected Default", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionKey: "agent:main:dashboard:parent:thread:child",
        sessionStore: { "agent:main:dashboard:parent": staleDefault },
      }),
    ).toBeNull();
  });

  it("does not inherit a parent pin after the child explicitly selects default", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionEntry: { ...staleDefault, providerOverride: "google-vertex" },
        sessionKey: "agent:main:dashboard:child",
        parentSessionKey: "agent:main:dashboard:parent",
        sessionStore: { "agent:main:dashboard:parent": makeEntry(userPin) },
      }),
    ).toBeNull();
  });

  it("reloads parent model choices after in-process writes", async () => {
    const state = await createOpenClawTestState({ label: "stored-model-overrides" });
    const parent = { agentId: "main", sessionKey: "agent:main:telegram:dm:parent" };
    const resolve = () =>
      resolveStoredModelOverrideAsync({
        defaultProvider: "openai",
        sessionKey: `${parent.sessionKey}:thread:child`,
        loadSessionEntry: (sessionKey) =>
          readSessionEntryReadOnlyInWorker({ ...parent, sessionKey }),
      });
    try {
      const config = { agents: { entries: { main: {} } } };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      for (const [index, entry] of [
        userPin,
        fallback,
        {
          providerOverride: "openai",
          modelOverride: "gpt-primary",
          modelOverrideSource: "user" as const,
        },
      ].entries()) {
        await replaceSessionEntry(parent, {
          sessionId: "parent-session",
          updatedAt: index + 1,
          ...entry,
        });
        const result = await resolve();
        if (entry.modelOverrideSource === "auto") {
          expect(result).toBeNull();
        } else {
          expect(result).toEqual(parentChoice(entry.providerOverride, entry.modelOverride));
        }
      }
    } finally {
      await state.cleanup();
    }
  });
});
