import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  applyModelOverrideToSessionEntry,
  MODEL_SELECTION_LOCKED_MESSAGE,
  ModelSelectionLockedError,
  repairProviderWrappedModelOverride,
} from "./model-overrides.js";

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

function contextBudgetStatus(
  { provider, model }: typeof openai,
  contextTokenBudget = 200_000,
): NonNullable<SessionEntry["contextBudgetStatus"]> {
  return {
    schemaVersion: 1,
    source: "pre-prompt-estimate",
    updatedAt: before,
    provider,
    model,
    route: "fits",
    shouldCompact: false,
    estimatedPromptTokens: Math.floor(contextTokenBudget * 0.6),
    contextTokenBudget,
    promptBudgetBeforeReserve: contextTokenBudget - 10_000,
    reserveTokens: 10_000,
    effectiveReserveTokens: 10_000,
    remainingPromptBudgetTokens: Math.floor(contextTokenBudget * 0.4),
    overflowTokens: 0,
    toolResultReducibleChars: 0,
    messageCount: 2,
    unwindowedMessageCount: 2,
  };
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
    contextBudgetStatus: contextBudgetStatus(anthropic),
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
        contextBudgetStatus: contextBudgetStatus(
          { provider: "local", model: "sunapi386/llama-3-lexi-uncensored:8b" },
          4_096,
        ),
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

  it.each([
    { preserveAuthProfileOverride: undefined, expectedProfile: undefined },
    { preserveAuthProfileOverride: true, expectedProfile: "openai:work" },
  ])(
    "keeps auth profile metadata only when preservation is $preserveAuthProfileOverride",
    ({ preserveAuthProfileOverride, expectedProfile }) => {
      const entry = makeEntry({
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        authProfileOverride: "openai:work",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 2,
      });

      applyModelOverrideToSessionEntry({
        entry,
        selection: { ...openai, model: "gpt-4.1" },
        preserveAuthProfileOverride,
      });

      expect(entry.authProfileOverride).toBe(expectedProfile);
      expect(entry.authProfileOverrideSource).toBe(expectedProfile ? "user" : undefined);
      expect(entry.authProfileOverrideCompactionCount).toBe(expectedProfile ? 2 : undefined);
    },
  );
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
