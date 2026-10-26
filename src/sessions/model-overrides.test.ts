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

  type Update = Parameters<typeof applyModelOverrideToSessionEntry>[0];
  function update(fields: Partial<SessionEntry>, options: Omit<Update, "entry">) {
    const entry = makeEntry(fields);
    expect(applyModelOverrideToSessionEntry({ entry, ...options }).updated).toBe(true);
    expect(entry.updatedAt).toBeGreaterThan(before);
    return entry;
  }
  it("clears stale runtime for an unchanged override", () => {
    const entry = update({ ...override, ...runtime }, { selection: openai });
    expect(entry).toMatchObject(override);
    expectCleared(entry, ...runtimeFields);
  });
  it("clears override and context when selecting the default", () => {
    const entry = update(
      {
        ...override,
        modelOverrideRouteResolution: "resolved",
        contextTokens: 4_096,
        contextBudgetStatus: contextBudgetStatusFixture(openai),
      },
      {
        selection: { ...openai, isDefault: true },
      },
    );
    expectCleared(entry, ...overrideFields, ...runtimeFields);
  });
  it("marks a runtime-only switch to default pending", () => {
    const entry = update(runtime, {
      selection: { ...openai, isDefault: true },
      markLiveSwitchPending: true,
    });
    expect(entry.liveModelSwitchPending).toBe(true);
    expectCleared(entry, ...runtimeFields);
  });
  it("marks a profile-only switch pending", () => {
    const entry = update(
      { ...override, authProfileOverride: "oldprofile", authProfileOverrideSource: "user" },
      {
        selection: openai,
        profileOverride: "newprofile",
        markLiveSwitchPending: true,
      },
    );
    expect(entry).toMatchObject({
      authProfileOverride: "newprofile",
      liveModelSwitchPending: true,
    });
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

  it.each([false, true])("repairs a wrapped override (default=%s)", (isDefault) => {
    const entry = wrappedEntry(isDefault ? {} : runtime);
    const selection = isDefault
      ? { defaultProvider: runtime.modelProvider, defaultModel: runtime.model }
      : defaultSelection;
    expect(repairProviderWrappedModelOverride({ entry, ...selection }).updated).toBe(true);
    if (isDefault) {
      expectCleared(entry, "providerOverride", "modelOverride", "modelOverrideSource");
    } else {
      expect(entry).toMatchObject({
        providerOverride: runtime.modelProvider,
        modelOverride: runtime.model,
        modelOverrideSource: "user",
      });
      expectCleared(entry, "modelProvider", "model", "contextTokens");
    }
    expect(entry.updatedAt).toBeGreaterThan(before);
  });
});

describe("stored model overrides", () => {
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
  const parentKey = "agent:main:dashboard:parent";

  function parentChoice(provider: string, model: string) {
    return { provider, model, source: "parent", routeResolution: "raw" };
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
        makeEntry(userPin),
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
        sessionKey: "agent:main:dashboard:child",
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

  it("inherits configured automatic choices", async () => {
    expect(
      await resolveStoredModelOverrideAsync({
        defaultProvider: "openai",
        sessionKey: `${parentKey}:thread:child`,
        sessionStore: { [parentKey]: makeEntry(automatic) },
      }),
    ).toEqual(parentChoice("google-vertex", "gemini-fallback"));
  });

  it("honors a parent's explicit Default marker", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionKey: `${parentKey}:thread:child`,
        sessionStore: { [parentKey]: staleDefault },
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
