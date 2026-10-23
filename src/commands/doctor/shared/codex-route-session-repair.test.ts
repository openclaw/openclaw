import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { contextBudgetStatusFixture } from "../../../config/sessions/context-budget.test-support.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { legacyCodexProviderIdentityKey } from "./codex-route-model-ref.js";
import { repairCodexSessionStoreRoutes } from "./codex-route-session-repair.test-support.js";
import { collectBlockedLegacyOpenAICodexProviderPlan } from "./legacy-config-migrations.runtime.models.js";

function session(fields: Partial<SessionEntry>): SessionEntry {
  return { sessionId: "s1", updatedAt: 1, ...fields };
}

function autoSession(fields: Partial<SessionEntry>): SessionEntry {
  return session({
    modelOverrideSource: "auto",
    authProfileOverride: "openai-codex:default",
    authProfileOverrideSource: "auto",
    ...fields,
  });
}

describe("repairCodexSessionStoreRoutes", () => {
  it.each([
    {
      name: "persisted routes",
      entry: autoSession({
        modelProvider: "openai-codex",
        model: "gpt-5.5",
        providerOverride: "openai-codex",
        modelOverride: "openai-codex/gpt-5.4",
        agentHarnessId: "codex",
        agentRuntimeOverride: "codex",
        authProfileOverrideCompactionCount: 2,
        fallbackNotice: {
          kind: "active",
          selectedModel: "openai-codex/gpt-5.5",
          activeModel: "openai-codex/gpt-5.4",
          reason: "rate-limit",
        },
      }),
      expected: {
        modelProvider: "openai",
        model: "gpt-5.5",
        modelOverride: "gpt-5.4",
        authProfileOverrideCompactionCount: 2,
        agentRuntimeOverride: "codex",
      },
      removed: ["agentHarnessId", "fallbackNotice"] as const,
    },
    {
      name: "providerless auto overrides",
      entry: autoSession({
        modelProvider: "ollama",
        model: "gpt-5.5",
        modelOverride: "gpt-5.5",
        contextTokens: 64_000,
        contextTokensSource: "runtime",
        contextBudgetStatus: contextBudgetStatusFixture({ model: "gpt-5.5" }),
      }),
      expected: { modelOverride: "gpt-5.5" },
      removed: [
        "modelProvider",
        "model",
        "contextTokens",
        "contextTokensSource",
        "contextBudgetStatus",
      ] as const,
    },
  ])("repairs $name while preserving selected auth accounts", ({ entry, expected, removed }) => {
    using _ = vi.spyOn(Date, "now").mockReturnValue(123);
    const store: Record<string, SessionEntry> = {
      main: entry,
      other: { sessionId: "s2", updatedAt: 2, agentHarnessId: "codex" },
    };
    expect(
      repairCodexSessionStoreRoutes({
        store,
        authProfileIdMap: new Map([["openai-codex:default", "openai:chatgpt-default"]]),
      }),
    ).toEqual(["main"]);
    const main = expectDefined(store.main, "main");
    expect(main).toMatchObject({
      updatedAt: 123,
      providerOverride: "openai",
      modelOverrideSource: "auto",
      modelOverrideRouteResolution: "resolved",
      authProfileOverride: "openai:chatgpt-default",
      authProfileOverrideSource: "auto",
      ...expected,
    });
    for (const key of removed) {
      expect(main[key], key).toBeUndefined();
    }
    expect(store.other).toMatchObject({ updatedAt: 2, agentHarnessId: "codex" });
  });

  it("keeps the whole provider-conflicted session namespace legacy", () => {
    const store: Record<string, SessionEntry> = {
      blocked: session({
        modelProvider: "codex",
        model: "gpt-5.6-sol",
        providerOverride: "codex",
        modelOverride: "codex/gpt-5.6-sol",
      }),
      migrate: session({ updatedAt: 2, modelProvider: "codex", model: "gpt-5.3-mini" }),
      providerOnly: session({ updatedAt: 3, modelProvider: "codex" }),
    };
    const blockedNamespace = expectDefined(
      legacyCodexProviderIdentityKey("codex"),
      "blocked session namespace test invariant",
    );
    const original = structuredClone(store);

    const result = repairCodexSessionStoreRoutes({
      store,
      blockedModelIdentities: new Set([blockedNamespace]),
    });

    expect(result).toEqual([]);
    expect(store).toEqual(original);
  });

  it("retains a fallback notice atomically when one legacy endpoint is blocked", () => {
    const store: Record<string, SessionEntry> = {
      main: session({
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        fallbackNotice: {
          kind: "active",
          selectedModel: "codex/gpt-5.6-sol",
          activeModel: "openai/gpt-5.6-sol",
          reason: "rate-limit",
        },
      }),
    };
    const original = structuredClone(store);
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
      blockedModelIdentities: new Set([blockedIdentity]),
    });

    expect(result).toEqual([]);
    expect(store).toEqual(original);
  });

  it("skips valid locked agent-harness rows while repairing ordinary legacy routes", () => {
    using _ = vi.spyOn(Date, "now").mockReturnValue(123);
    const supervisedKey = "agent:main:harness:codex:supervision:abc123";
    const ordinaryLockedKey = "agent:main:ordinary-locked";
    const lockedEntry = session({
      sessionId: "s-supervised",
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
    });
    const store: Record<string, SessionEntry> = {
      [supervisedKey]: lockedEntry,
      [ordinaryLockedKey]: { ...lockedEntry, sessionId: "s-ordinary-locked" },
      ordinary: session({
        sessionId: "s-ordinary",
        updatedAt: 2,
        modelProvider: "openai-codex",
        model: "gpt-5.5",
        agentHarnessId: "codex",
      }),
    };
    const supervised = structuredClone(store[supervisedKey]);
    const ordinaryLocked = structuredClone(store[ordinaryLockedKey]);

    const result = repairCodexSessionStoreRoutes({ store });

    expect(result).toEqual(["ordinary"]);
    expect(store[supervisedKey]).toEqual(supervised);
    expect(store[ordinaryLockedKey]).toEqual(ordinaryLocked);
    expect(store.ordinary).toMatchObject({
      updatedAt: 123,
      modelProvider: "openai",
      model: "gpt-5.5",
    });
    expect(store.ordinary?.agentHarnessId).toBeUndefined();
  });
});
