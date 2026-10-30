import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { contextBudgetStatusFixture } from "../../../config/sessions/context-budget.test-support.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { legacyCodexProviderIdentityKey } from "./codex-route-model-ref.js";
import { repairCodexSessionStoreRoutes } from "./codex-route-session-repair.test-support.js";

function session(fields: Partial<SessionEntry>): SessionEntry {
  return { sessionId: "s1", updatedAt: 1, ...fields };
}

const blockedNamespace = expectDefined(
  legacyCodexProviderIdentityKey("codex"),
  "blocked namespace",
);
function expectBlocked(store: Record<string, SessionEntry>) {
  const original = structuredClone(store);
  expect(
    repairCodexSessionStoreRoutes({ store, blockedModelIdentities: new Set([blockedNamespace]) }),
  ).toEqual([]);
  expect(store).toEqual(original);
}

function repair(entry: Partial<SessionEntry>) {
  using _ = vi.spyOn(Date, "now").mockReturnValue(123);
  const store: Record<string, SessionEntry> = {
    main: session({
      modelOverrideSource: "auto",
      authProfileOverride: "openai-codex:default",
      authProfileOverrideSource: "auto",
      ...entry,
    }),
    other: { sessionId: "s2", updatedAt: 2, agentHarnessId: "codex" },
  };
  expect(
    repairCodexSessionStoreRoutes({
      store,
      authProfileIdMap: new Map([["openai-codex:default", "openai:chatgpt-default"]]),
    }),
  ).toEqual(["main"]);
  expect(store.other).toMatchObject({ updatedAt: 2, agentHarnessId: "codex" });
  const main = expectDefined(store.main, "main");
  expect(main).toMatchObject({
    updatedAt: 123,
    providerOverride: "openai",
    modelOverrideSource: "auto",
    modelOverrideRouteResolution: "resolved",
    authProfileOverride: "openai:chatgpt-default",
    authProfileOverrideSource: "auto",
  });
  return main;
}

const legacyRoute = {
  modelProvider: "openai-codex",
  model: "gpt-5.5",
  providerOverride: "openai-codex",
  modelOverride: "openai-codex/gpt-5.4",
  agentHarnessId: "codex",
  agentRuntimeOverride: "codex",
};
const fallbackNotice = {
  kind: "active",
  selectedModel: "openai-codex/gpt-5.5",
  activeModel: "openai-codex/gpt-5.4",
} as const;

describe("repairCodexSessionStoreRoutes", () => {
  it("repairs persisted routes while preserving selected auth accounts", () => {
    const main = repair({
      ...legacyRoute,
      authProfileOverrideCompactionCount: 2,
      fallbackNotice: { ...fallbackNotice, reason: "rate-limit" },
    });
    expect(main).toMatchObject({
      modelProvider: "openai",
      model: "gpt-5.5",
      modelOverride: "gpt-5.4",
      authProfileOverrideCompactionCount: 2,
      agentRuntimeOverride: "codex",
    });
    expect(main.agentHarnessId).toBeUndefined();
    expect(main.fallbackNotice).toBeUndefined();
  });

  it("repairs providerless auto overrides while preserving selected auth accounts", () => {
    const main = repair({
      modelProvider: "ollama",
      model: "gpt-5.5",
      modelOverride: "gpt-5.5",
      contextTokens: 64_000,
      contextTokensSource: "runtime",
      contextBudgetStatus: contextBudgetStatusFixture({ model: "gpt-5.5" }),
    });
    expect(main.modelOverride).toBe("gpt-5.5");
    expect(main.modelProvider).toBeUndefined();
    expect(main.model).toBeUndefined();
    expect(main.contextTokens).toBeUndefined();
    expect(main.contextTokensSource).toBeUndefined();
    expect(main.contextBudgetStatus).toBeUndefined();
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
    expectBlocked(store);
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
    expectBlocked(store);
  });

  it("skips valid locked agent-harness rows while repairing ordinary legacy routes", () => {
    using _ = vi.spyOn(Date, "now").mockReturnValue(123);
    const supervisedKey = "agent:main:harness:codex:supervision:abc123";
    const ordinaryLockedKey = "agent:main:ordinary-locked";
    const lockedEntry = session({
      sessionId: "s-supervised",
      modelSelectionLocked: true,
      ...legacyRoute,
      fallbackNotice,
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

    expect(repairCodexSessionStoreRoutes({ store })).toEqual(["ordinary"]);
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
