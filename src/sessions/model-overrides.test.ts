import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { SessionEntry } from "../config/sessions.js";
import { contextBudgetStatusFixture } from "../config/sessions/context-budget.test-support.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  applyModelOverrideToSessionEntry,
  MODEL_SELECTION_LOCKED_MESSAGE,
  ModelSelectionLockedError,
  repairProviderWrappedModelOverride,
} from "./model-overrides.js";
import {
  resolveDirectStoredModelOverride,
  resolveStoredModelOverride,
  resolveStoredModelOverrideAsync,
  resolveStoredModelOverrideCore,
} from "./stored-model-overrides.js";

const openai = { provider: "openai", model: "gpt-5.4" };
const anthropic = { provider: "anthropic", model: "claude-sonnet-4-6" };
const before = Date.now() - 5_000;

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "session", updatedAt: before, ...overrides };
}

function expectCleared(entry: SessionEntry, ...fields: (keyof SessionEntry)[]) {
  for (const field of fields) {
    expect(entry[field], field).toBeUndefined();
  }
}

describe("applyModelOverrideToSessionEntry", () => {
  it("rejects locked session model mutations before changing any fields", () => {
    const entry = makeEntry({
      updatedAt: 10,
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelSelectionLocked: true,
    });
    const unchanged = { ...entry };

    expect(() => applyModelOverrideToSessionEntry({ entry, selection: anthropic })).toThrow(
      ModelSelectionLockedError,
    );
    expect(() =>
      applyModelOverrideToSessionEntry({
        entry,
        selection: { ...openai, isDefault: true },
      }),
    ).toThrow(MODEL_SELECTION_LOCKED_MESSAGE);
    expect(entry).toEqual(unchanged);
  });

  const runtime = {
    modelProvider: anthropic.provider,
    model: anthropic.model,
    contextTokens: 160_000,
    contextBudgetStatus: contextBudgetStatusFixture(anthropic),
  };
  const override = { providerOverride: openai.provider, modelOverride: openai.model };
  const runtimeFields = ["modelProvider", "model", "contextTokens", "contextBudgetStatus"] as const;
  const overrideFields = [
    "providerOverride",
    "modelOverride",
    "modelOverrideSource",
    "modelOverrideRouteResolution",
  ] as const;

  it.each([
    {
      name: "unchanged override with stale runtime fields",
      fields: { ...override, ...runtime },
      selection: openai,
      cleared: runtimeFields,
      expected: override,
    },
    {
      name: "default replacing a local override",
      fields: {
        providerOverride: "local",
        modelOverride: "sunapi386/llama-3-lexi-uncensored:8b",
        modelOverrideRouteResolution: "resolved" as const,
        contextTokens: 4_096,
        contextBudgetStatus: contextBudgetStatusFixture({
          provider: "local",
          model: "sunapi386/llama-3-lexi-uncensored:8b",
          contextTokenBudget: 4_096,
        }),
      },
      selection: { provider: "local", model: "llama3.1:8b", isDefault: true },
      cleared: [...overrideFields, "contextTokens", "contextBudgetStatus"] as const,
      expected: {},
    },
    {
      name: "default with runtime-only fields and a pending live switch",
      fields: { ...runtime, contextTokens: 200_000 },
      selection: { ...openai, isDefault: true },
      cleared: runtimeFields,
      expected: { liveModelSwitchPending: true },
      markLiveSwitchPending: true,
    },
    {
      name: "profile-only pending switch",
      fields: {
        ...override,
        authProfileOverride: "oldprofile",
        authProfileOverrideSource: "user" as const,
      },
      selection: openai,
      cleared: [],
      expected: { authProfileOverride: "newprofile", liveModelSwitchPending: true },
      profileOverride: "newprofile",
      markLiveSwitchPending: true,
    },
  ])("updates $name", ({ name: _name, fields, selection, cleared, expected, ...options }) => {
    const entry = makeEntry(fields);
    expect(applyModelOverrideToSessionEntry({ entry, selection, ...options }).updated).toBe(true);
    expect(entry).toMatchObject(expected);
    expectCleared(entry, ...cleared);
    expect(entry.updatedAt).toBeGreaterThan(before);
  });

  it("persists an explicit default selection and clears it on a user pin", () => {
    const entry = makeEntry({
      providerOverride: anthropic.provider,
      modelOverride: anthropic.model,
      modelOverrideSource: "user",
    });
    applyModelOverrideToSessionEntry({
      entry,
      selection: { ...openai, isDefault: true },
      explicitDefaultSelection: true,
    });
    expect(entry.modelOverrideSource).toBe("default");
    applyModelOverrideToSessionEntry({ entry, selection: anthropic });
    expect(entry.modelOverrideSource).toBe("user");
  });

  it("clears auth profile metadata on an unpreserved model switch", () => {
    const entry = makeEntry({
      ...override,
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    });
    applyModelOverrideToSessionEntry({ entry, selection: { ...openai, model: "gpt-4.1" } });
    expectCleared(
      entry,
      "authProfileOverride",
      "authProfileOverrideSource",
      "authProfileOverrideCompactionCount",
    );
  });
});

describe("repairProviderWrappedModelOverride", () => {
  function wrappedEntry(overrides: Partial<SessionEntry> = {}) {
    return makeEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-haiku-4.5",
      modelOverrideSource: "user",
      ...overrides,
    });
  }
  const runtime = {
    modelProvider: "openrouter",
    model: "anthropic/claude-haiku-4.5",
    contextTokens: 200_000,
  };
  const defaultSelection = { defaultProvider: "openai", defaultModel: "gpt-5.4" };

  it("rejects provider-wrapped repair for locked sessions without mutating them", () => {
    const entry = wrappedEntry({ ...runtime, modelSelectionLocked: true });
    const unchanged = { ...entry };

    expect(() => repairProviderWrappedModelOverride({ entry, ...defaultSelection })).toThrow(
      ModelSelectionLockedError,
    );
    expect(entry).toEqual(unchanged);
  });

  it("restores a provider-wrapped override from aligned runtime model fields", () => {
    const entry = wrappedEntry(runtime);
    const result = repairProviderWrappedModelOverride({ entry, ...defaultSelection });

    expect(result.updated).toBe(true);
    expect(entry).toMatchObject({
      providerOverride: "openrouter",
      modelOverride: "anthropic/claude-haiku-4.5",
      modelOverrideSource: "user",
    });
    expectCleared(entry, "modelProvider", "model", "contextTokens");
    expect((entry.updatedAt ?? 0) > before).toBe(true);
  });

  it("clears a provider-wrapped override that matches the configured default", () => {
    const entry = wrappedEntry();

    const result = repairProviderWrappedModelOverride({
      entry,
      defaultProvider: "openrouter",
      defaultModel: "anthropic/claude-haiku-4.5",
    });

    expect(result.updated).toBe(true);
    expectCleared(entry, "providerOverride", "modelOverride", "modelOverrideSource");
    expect((entry.updatedAt ?? 0) > before).toBe(true);
  });
});

describe("stored model overrides", () => {
  function storedEntry(fields: Partial<SessionEntry>): SessionEntry {
    return makeEntry({ updatedAt: 1, ...fields });
  }

  const staleDefault = storedEntry({
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
  const parentKey = "agent:main:dashboard:parent";

  function parentChoice(provider: string, model: string) {
    return { provider, model, source: "parent", routeResolution: "raw" };
  }

  function resolveParentOverride(parent: Partial<SessionEntry>) {
    const rootKey = "agent:main:discord:channel:root";
    return resolveStoredModelOverrideAsync({
      defaultProvider: "openai",
      sessionKey: `${rootKey}:thread:child`,
      sessionStore: { [rootKey]: storedEntry(parent) },
    });
  }

  it.each([
    ["sync", resolveStoredModelOverrideCore],
    ["async", resolveStoredModelOverrideAsync],
  ] as const)("does not load a parent for a resolved %s choice", async (_name, resolve) => {
    const loadSessionEntry = vi.fn(() => {
      throw new Error("resolved choices must not load a parent");
    });
    for (const [sessionEntry, expected] of [
      [staleDefault, null],
      [
        storedEntry(userPin),
        {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          source: "session",
          routeResolution: "raw",
        },
      ],
    ] as const) {
      const result = await resolve({
        defaultProvider: "openai",
        sessionEntry,
        parentSessionKey: parentKey,
        loadSessionEntry,
      });
      expect(result).toEqual(expected);
    }
    expect(loadSessionEntry).not.toHaveBeenCalled();
  });

  it("recovers resolved provenance for legacy auto-fallback overrides", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionEntry: storedEntry({
          providerOverride: "cloudflare-ai-gateway",
          modelOverride: "gemini-2.5-flash-lite",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "anthropic",
          modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
        }),
      }),
    ).toMatchObject({ routeResolution: "resolved" });
  });

  it("inherits configured automatic choices", async () => {
    expect(await resolveParentOverride(automatic)).toEqual(
      parentChoice("google-vertex", "gemini-fallback"),
    );
  });

  it.each([
    ["direct", resolveDirectStoredModelOverride, { sessionEntry: staleDefault }],
    [
      "parent",
      resolveStoredModelOverride,
      {
        sessionKey: `${parentKey}:thread:child`,
        sessionStore: { [parentKey]: staleDefault },
      },
    ],
    [
      "child",
      resolveStoredModelOverride,
      {
        sessionEntry: { ...staleDefault, providerOverride: "google-vertex" },
        sessionKey: "agent:main:dashboard:child",
        parentSessionKey: parentKey,
        sessionStore: { [parentKey]: storedEntry(userPin) },
      },
    ],
  ] as const)("honors an explicit Default marker on the %s", (_name, resolve, params) => {
    expect(resolve({ defaultProvider: "openai", ...params })).toBeNull();
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
        const expected =
          entry.modelOverrideSource === "auto"
            ? null
            : parentChoice(entry.providerOverride, entry.modelOverride);
        expect(await resolve()).toEqual(expected);
      }
    } finally {
      await state.cleanup();
    }
  });
});
