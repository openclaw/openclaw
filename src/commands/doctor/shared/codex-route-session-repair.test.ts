import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { legacyCodexProviderIdentityKey } from "./codex-route-model-ref.js";
import { repairCodexSessionStoreRoutes } from "./codex-route-session-repair.test-support.js";
import { collectBlockedLegacyOpenAICodexProviderPlan } from "./legacy-config-migrations.runtime.models.js";

function getSession(store: Record<string, SessionEntry>, key: string): SessionEntry {
  return expectDefined(store[key], `store.${key} test invariant`);
}

describe("repairCodexSessionStoreRoutes", () => {
  it("repairs persisted session routes while preserving selected auth accounts", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai-codex",
        model: "gpt-5.5",
        providerOverride: "openai-codex",
        modelOverride: "openai-codex/gpt-5.4",
        modelOverrideSource: "auto",
        agentHarnessId: "codex",
        agentRuntimeOverride: "codex",
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 2,
        fallbackNotice: {
          kind: "active",
          selectedModel: "openai-codex/gpt-5.5",
          activeModel: "openai-codex/gpt-5.4",
          reason: "rate-limit",
        },
      },
      other: { sessionId: "s2", updatedAt: 2, agentHarnessId: "codex" },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
      authProfileIdMap: new Map([["openai-codex:default", "openai:chatgpt-default"]]),
    });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(getSession(store, "main").updatedAt).toBe(123);
    expect(getSession(store, "main").modelProvider).toBe("openai");
    expect(getSession(store, "main").model).toBe("gpt-5.5");
    expect(getSession(store, "main").providerOverride).toBe("openai");
    expect(getSession(store, "main").modelOverride).toBe("gpt-5.4");
    expect(getSession(store, "main").modelOverrideSource).toBe("auto");
    expect(getSession(store, "main").modelOverrideRouteResolution).toBe("resolved");
    expect(getSession(store, "main").authProfileOverride).toBe("openai:chatgpt-default");
    expect(getSession(store, "main").authProfileOverrideSource).toBe("auto");
    expect(getSession(store, "main").authProfileOverrideCompactionCount).toBe(2);
    expect(getSession(store, "main").agentHarnessId).toBeUndefined();
    expect(getSession(store, "main").agentRuntimeOverride).toBe("codex");
    expect(getSession(store, "main").fallbackNotice).toBeUndefined();
    expect(getSession(store, "other").updatedAt).toBe(2);
    expect(getSession(store, "other").agentHarnessId).toBe("codex");
  });

  it("rewrites only exactly mapped auth pins on otherwise canonical sessions", () => {
    const store: Record<string, SessionEntry> = {
      selected: {
        sessionId: "selected",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5.5",
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 3,
      },
      unknown: {
        sessionId: "unknown",
        updatedAt: 2,
        authProfileOverride: "openai-codex:missing",
        authProfileOverrideSource: "user",
      },
      canonical: {
        sessionId: "canonical",
        updatedAt: 3,
        authProfileOverride: "openai:default",
        authProfileOverrideSource: "auto",
      },
    };
    const authProfileIdMap = new Map([["openai-codex:default", "openai:chatgpt-default"]]);

    expect(repairCodexSessionStoreRoutes({ store, now: 123, authProfileIdMap })).toEqual({
      changed: true,
      sessionKeys: ["selected"],
    });
    expect(store.selected).toMatchObject({
      updatedAt: 123,
      authProfileOverride: "openai:chatgpt-default",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 3,
    });
    expect(store.unknown).toMatchObject({
      updatedAt: 2,
      authProfileOverride: "openai-codex:missing",
    });
    expect(store.canonical).toMatchObject({
      updatedAt: 3,
      authProfileOverride: "openai:default",
    });
    expect(repairCodexSessionStoreRoutes({ store, now: 456, authProfileIdMap })).toEqual({
      changed: false,
      sessionKeys: [],
    });
    expect(store.selected?.updatedAt).toBe(123);
  });

  it("repairs shipped codex namespace session route refs", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "codex",
        model: "codex/gpt-5.6-sol",
        providerOverride: "codex",
        modelOverride: "codex/gpt-5.6-sol",
        authProfileOverride: "codex:default",
        authProfileOverrideSource: "auto",
        fallbackNotice: {
          kind: "active",
          selectedModel: "codex/gpt-5.6-sol",
          activeModel: "openai/gpt-5.6-sol",
        },
        agentRuntimeOverride: "codex",
      },
    };

    const result = repairCodexSessionStoreRoutes({ store, now: 123 });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(store.main).toMatchObject({
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
      authProfileOverride: "codex:default",
      updatedAt: 123,
    });
    expect(store.main?.fallbackNotice).toBeUndefined();
    expect(store.main?.agentRuntimeOverride).toBe("codex");
  });

  it("treats slash model ids as raw for custom providers while migrating legacy pairs", () => {
    const store: Record<string, SessionEntry> = {
      custom: {
        sessionId: "s-custom",
        updatedAt: 1,
        modelProvider: "custom",
        model: "codex/foo",
        providerOverride: "custom",
        modelOverride: "openai-codex/bar",
        agentRuntimeOverride: "openclaw",
      },
      legacy: {
        sessionId: "s-legacy",
        updatedAt: 2,
        modelProvider: "codex",
        model: "codex/foo",
      },
    };

    const result = repairCodexSessionStoreRoutes({ store, now: 123 });

    expect(result).toEqual({ changed: true, sessionKeys: ["legacy"] });
    expect(store.custom).toMatchObject({
      modelProvider: "custom",
      model: "codex/foo",
      providerOverride: "custom",
      modelOverride: "openai-codex/bar",
      agentRuntimeOverride: "openclaw",
      updatedAt: 1,
    });
    expect(store.legacy).toMatchObject({
      modelProvider: "openai",
      model: "foo",
      agentRuntimeOverride: "codex",
      updatedAt: 123,
    });
  });

  it("keeps the whole provider-conflicted session namespace legacy", () => {
    const store: Record<string, SessionEntry> = {
      blocked: {
        sessionId: "s-blocked",
        updatedAt: 1,
        modelProvider: "codex",
        model: "gpt-5.6-sol",
        providerOverride: "codex",
        modelOverride: "codex/gpt-5.6-sol",
      },
      migrate: {
        sessionId: "s-migrate",
        updatedAt: 2,
        modelProvider: "codex",
        model: "gpt-5.3-mini",
      },
      providerOnly: { sessionId: "s-provider-only", updatedAt: 3, modelProvider: "codex" },
    };
    const blockedNamespace = expectDefined(
      legacyCodexProviderIdentityKey("codex"),
      "blocked session namespace test invariant",
    );

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
      blockedModelIdentities: new Set([blockedNamespace]),
    });

    expect(result).toEqual({ changed: false, sessionKeys: [] });
    expect(store.blocked).toMatchObject({
      modelProvider: "codex",
      model: "gpt-5.6-sol",
      providerOverride: "codex",
      modelOverride: "codex/gpt-5.6-sol",
      updatedAt: 1,
    });
    expect(store.migrate).toMatchObject({
      modelProvider: "codex",
      model: "gpt-5.3-mini",
      updatedAt: 2,
    });
    expect(store.providerOnly).toMatchObject({
      modelProvider: "codex",
      updatedAt: 3,
    });
  });

  it("retains a fallback notice atomically when one legacy endpoint is blocked", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        fallbackNotice: {
          kind: "active",
          selectedModel: "codex/gpt-5.6-sol",
          activeModel: "openai/gpt-5.6-sol",
          reason: "rate-limit",
        },
      },
    };
    // Build the blocked identity through the production plan so the test
    // exercises the same composition doctor uses.
    const blockedIdentity = expectDefined(
      collectBlockedLegacyOpenAICodexProviderPlan({
        models: {
          providers: {
            codex: { models: [{ id: "gpt-5.6-sol", api: "openai-responses" }] },
            openai: { models: [{ id: "gpt-5.6-sol", api: "openai-chatgpt-responses" }] },
          },
        },
      }).blockedModelIdentities[0],
      "blocked fallback notice model identity test invariant",
    );

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
      blockedModelIdentities: new Set([blockedIdentity]),
    });

    expect(result).toEqual({ changed: false, sessionKeys: [] });
    expect(store.main).toMatchObject({
      updatedAt: 1,
      fallbackNotice: {
        kind: "active",
        selectedModel: "codex/gpt-5.6-sol",
        activeModel: "openai/gpt-5.6-sol",
        reason: "rate-limit",
      },
    });
  });

  it("leaves session runtime intent untouched for fallback-notice-only cleanup", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        fallbackNotice: {
          kind: "active",
          selectedModel: "codex/gpt-5.6-sol",
          activeModel: "openai/gpt-5.6-sol",
          reason: "rate-limit",
        },
      },
    };

    const result = repairCodexSessionStoreRoutes({ store, now: 123 });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(store.main?.fallbackNotice).toBeUndefined();
    expect(store.main?.agentRuntimeOverride).toBeUndefined();
    expect(store.main?.agentHarnessId).toBeUndefined();
  });

  it("skips valid locked agent-harness rows while repairing ordinary legacy routes", () => {
    const supervisedKey = "agent:main:harness:codex:supervision:abc123";
    const ordinaryLockedKey = "agent:main:ordinary-locked";
    const lockedEntry: SessionEntry = {
      sessionId: "s-supervised",
      updatedAt: 1,
      modelSelectionLocked: true,
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      modelProvider: "openai-codex",
      model: "gpt-5.5",
      providerOverride: "openai-codex",
      modelOverride: "openai-codex/gpt-5.4",
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai-codex/gpt-5.5",
        activeModel: "openai-codex/gpt-5.4",
      },
    };
    const store: Record<string, SessionEntry> = {
      [supervisedKey]: lockedEntry,
      [ordinaryLockedKey]: { ...lockedEntry, sessionId: "s-ordinary-locked" },
      ordinary: {
        sessionId: "s-ordinary",
        updatedAt: 2,
        modelProvider: "openai-codex",
        model: "gpt-5.5",
        agentHarnessId: "codex",
      },
    };
    const supervised = structuredClone(store[supervisedKey]);
    const ordinaryLocked = structuredClone(store[ordinaryLockedKey]);

    const result = repairCodexSessionStoreRoutes({ store, now: 123 });

    expect(result).toEqual({ changed: true, sessionKeys: ["ordinary"] });
    expect(store[supervisedKey]).toEqual(supervised);
    expect(store[ordinaryLockedKey]).toEqual(ordinaryLocked);
    expect(store.ordinary).toMatchObject({
      updatedAt: 123,
      modelProvider: "openai",
      model: "gpt-5.5",
    });
    expect(getSession(store, "ordinary").agentHarnessId).toBeUndefined();
  });

  it("preserves explicit OpenClaw runtime pins while repairing legacy session routes", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai-codex",
        model: "gpt-5.5",
        providerOverride: "openai-codex",
        modelOverride: "openai-codex/gpt-5.4",
        agentHarnessId: "pi",
        agentRuntimeOverride: "pi",
        authProfileOverride: "openai-codex:default",
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
    });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(getSession(store, "main").modelProvider).toBe("openai");
    expect(getSession(store, "main").model).toBe("gpt-5.5");
    expect(getSession(store, "main").providerOverride).toBe("openai");
    expect(getSession(store, "main").modelOverride).toBe("gpt-5.4");
    expect(getSession(store, "main").agentHarnessId).toBe("pi");
    expect(getSession(store, "main").agentRuntimeOverride).toBe("pi");
    expect(getSession(store, "main").authProfileOverride).toBe("openai-codex:default");
  });

  it("repairs providerless auto Codex session overrides", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "ollama",
        model: "gpt-5.5",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "auto",
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "auto",
        contextTokens: 64_000,
        contextTokensSource: "runtime",
        contextBudgetStatus: {
          schemaVersion: 1,
          source: "pre-prompt-estimate",
          updatedAt: 1,
          provider: "ollama",
          model: "gpt-5.5",
          route: "fits",
          shouldCompact: false,
          estimatedPromptTokens: 1_000,
          contextTokenBudget: 64_000,
          promptBudgetBeforeReserve: 62_000,
          reserveTokens: 2_000,
          effectiveReserveTokens: 2_000,
          remainingPromptBudgetTokens: 61_000,
          overflowTokens: 0,
          toolResultReducibleChars: 0,
          messageCount: 1,
          unwindowedMessageCount: 1,
        },
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
      authProfileIdMap: new Map([["openai-codex:default", "openai:chatgpt-default"]]),
    });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(getSession(store, "main").updatedAt).toBe(123);
    expect(getSession(store, "main").providerOverride).toBe("openai");
    expect(getSession(store, "main").modelOverride).toBe("gpt-5.5");
    expect(getSession(store, "main").modelOverrideSource).toBe("auto");
    expect(getSession(store, "main").modelOverrideRouteResolution).toBe("resolved");
    expect(getSession(store, "main").authProfileOverride).toBe("openai:chatgpt-default");
    expect(getSession(store, "main").authProfileOverrideSource).toBe("auto");
    expect(getSession(store, "main").modelProvider).toBeUndefined();
    expect(getSession(store, "main").model).toBeUndefined();
    expect(getSession(store, "main").contextTokens).toBeUndefined();
    expect(getSession(store, "main").contextTokensSource).toBeUndefined();
    expect(getSession(store, "main").contextBudgetStatus).toBeUndefined();
  });

  it("preserves legacy providerless overrides with Codex auth pins", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelOverride: "gpt-5.5",
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "auto",
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
    });

    expect(result).toEqual({ changed: false, sessionKeys: [] });
    expect(getSession(store, "main").updatedAt).toBe(1);
    expect(getSession(store, "main").providerOverride).toBeUndefined();
    expect(getSession(store, "main").modelOverride).toBe("gpt-5.5");
  });
});
