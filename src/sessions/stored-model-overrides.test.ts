import { describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resolveDirectStoredModelOverride,
  resolveStoredModelOverride,
  resolveStoredModelOverrideAsync,
} from "./stored-model-overrides.js";

function resolveParentOverride(parent: Partial<SessionEntry>) {
  const parentKey = "agent:main:discord:channel:root";
  return resolveStoredModelOverrideAsync({
    defaultProvider: "openai",
    sessionKey: `${parentKey}:thread:child`,
    sessionStore: { [parentKey]: { sessionId: "parent-session", updatedAt: 1, ...parent } },
  });
}

describe("resolveStoredModelOverride", () => {
  it("recovers resolved provenance for legacy auto-fallback overrides", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionEntry: {
          sessionId: "legacy-fallback",
          updatedAt: 1,
          providerOverride: "cloudflare-ai-gateway",
          modelOverride: "gemini-2.5-flash-lite",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "anthropic",
          modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
        },
      }),
    ).toMatchObject({ routeResolution: "resolved" });
  });

  it("awaits parent overrides without requiring a whole session store", async () => {
    const loadSessionEntry = vi.fn(async (sessionKey: string) =>
      sessionKey === "agent:main:telegram:dm:parent"
        ? {
            sessionId: "parent-session",
            updatedAt: 1782259200000,
            providerOverride: "anthropic",
            modelOverride: "claude-sonnet-4-7",
          }
        : undefined,
    );

    expect(
      await resolveStoredModelOverrideAsync({
        defaultProvider: "openai",
        loadSessionEntry,
        sessionKey: "agent:main:telegram:dm:parent:thread:child",
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-7",
      source: "parent",
      routeResolution: "raw",
    });
    expect(loadSessionEntry).toHaveBeenCalledWith("agent:main:telegram:dm:parent");
  });

  it("does not inherit active automatic fallback overrides from parent sessions", async () => {
    expect(
      await resolveParentOverride({
        providerOverride: "google-vertex",
        modelOverride: "gemini-fallback",
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-primary",
      }),
    ).toBeNull();
  });

  it("inherits configured automatic selections without fallback provenance", async () => {
    expect(
      await resolveParentOverride({
        providerOverride: "google-vertex",
        modelOverride: "gemini-fallback",
        modelOverrideSource: "auto",
      }),
    ).toEqual({
      provider: "google-vertex",
      model: "gemini-fallback",
      source: "parent",
      routeResolution: "raw",
    });
  });

  it("rejects stale direct fields behind an explicit Default marker", () => {
    expect(
      resolveDirectStoredModelOverride({
        defaultProvider: "openai",
        sessionEntry: {
          sessionId: "default-session",
          updatedAt: 1,
          modelOverrideSource: "default",
          providerOverride: "anthropic",
          modelOverride: "stale-model",
        },
      }),
    ).toBeNull();
  });

  it("does not inherit stale fields from a parent that explicitly selected Default", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionKey: "agent:main:dashboard:parent:thread:child",
        sessionStore: {
          "agent:main:dashboard:parent": {
            sessionId: "parent-session",
            updatedAt: 1,
            modelOverrideSource: "default",
            providerOverride: "anthropic",
            modelOverride: "stale-model",
          },
        },
      }),
    ).toBeNull();
  });

  it("does not inherit a parent pin after the child explicitly selects default", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionEntry: {
          sessionId: "child-session",
          updatedAt: 2,
          modelOverrideSource: "default",
          providerOverride: "google-vertex",
          modelOverride: "stale-model",
        },
        sessionKey: "agent:main:dashboard:child",
        parentSessionKey: "agent:main:dashboard:parent",
        sessionStore: {
          "agent:main:dashboard:parent": {
            sessionId: "parent-session",
            updatedAt: 1,
            providerOverride: "anthropic",
            modelOverride: "claude-sonnet-4-6",
            modelOverrideSource: "user",
          },
        },
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
      await state.writeConfig({ agents: { entries: { main: {} } } });
      for (const [index, entry] of [
        {
          providerOverride: "anthropic",
          modelOverride: "claude-sonnet-4-6",
          modelOverrideSource: "user" as const,
        },
        {
          providerOverride: "google-vertex",
          modelOverride: "gemini-fallback",
          modelOverrideSource: "auto" as const,
          modelOverrideFallbackOriginProvider: "openai",
          modelOverrideFallbackOriginModel: "gpt-primary",
        },
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
          expect(result).toEqual({
            provider: entry.providerOverride,
            model: entry.modelOverride,
            source: "parent",
            routeResolution: "raw",
          });
        }
      }
    } finally {
      await state.cleanup();
    }
  });
});
