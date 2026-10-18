// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type {
  ModelAuthStatusResult,
  ModelAuthStatusProvider,
  ModelCatalogEntry,
  ModelCatalogProviderOutcome,
} from "../../api/types.ts";
import {
  buildModelProviderCards,
  buildUnconfiguredProviderOptions,
  type DefaultModelSelection,
  modelCatalogRef,
  readModelProviderConfig,
  resolveDefaultModelPresentation,
} from "./data.ts";

function catalogEntry(overrides: Partial<ModelCatalogEntry> & { provider: string }) {
  return {
    id: `${overrides.provider}/model`,
    name: "Model",
    available: false,
    ...overrides,
  } satisfies ModelCatalogEntry;
}

function authStatus(
  providers: ModelAuthStatusResult["providers"],
  providerCapabilities?: ModelAuthStatusResult["providerCapabilities"],
): ModelAuthStatusResult {
  return { ts: 1, providers, ...(providerCapabilities ? { providerCapabilities } : {}) };
}

function authCards(providers: ModelAuthStatusResult["providers"]) {
  return buildCards({ authStatus: authStatus(providers) });
}

function firstCard(cards: ReturnType<typeof buildModelProviderCards>) {
  return expectDefined(cards[0], "first model provider card");
}

function providerConfig(value: string): { apiKey: string } {
  return Object.fromEntries([["apiKey", value]]) as { apiKey: string };
}

function defaultModelChoices(models: ModelCatalogEntry[] | null, selection: DefaultModelSelection) {
  return resolveDefaultModelPresentation(
    { models: models ?? [], hasSnapshot: models !== null, retired: false },
    {
      ...selection,
      thinkingLevel: undefined,
      thinkingOverridden: false,
      fastMode: undefined,
      fastModeOverridden: false,
    },
    null,
  ).configuredModels;
}

function buildCards(input: Partial<Parameters<typeof buildModelProviderCards>[0]>) {
  return buildModelProviderCards({ ...EMPTY_INPUT, ...input });
}

function provider(
  id: string,
  displayName: string,
  overrides: Partial<ModelAuthStatusProvider> = {},
): ModelAuthStatusProvider {
  return { provider: id, displayName, status: "ok", profiles: [], ...overrides };
}

function profile(
  profileId: string,
  status: "ok" | "expired" | "expiring" = "ok",
  logoutSupported?: boolean,
) {
  return {
    profileId,
    type: "oauth" as const,
    status,
    ...(logoutSupported === undefined ? {} : { logoutSupported }),
  };
}

const EMPTY_INPUT = {
  authStatus: null,
  models: null,
  providerUsage: null,
  costByProvider: null,
};
const redactedConfigValue = "[redacted]";

describe("buildModelProviderCards", () => {
  it.each([true])(
    "keeps environment-only model auth independently of API-key setup support (%s)",
    (apiKeySupported) => {
      const cards = buildCards({
        authStatus: authStatus(
          [
            provider("model-service", "Model Service", {
              status: "static",
              profiles: [],
              apiKey: { source: "env", envVar: "MODEL_SERVICE_API_KEY" },
            }),
            provider("web-search", "Web Search", {
              status: "static",
              profiles: [{ profileId: "search", type: "api_key", status: "static" }],
              apiKey: { source: "env", envVar: "WEB_SEARCH_API_KEY" },
            }),
          ],
          [
            { provider: "model-service", apiKeySupported, quickApiKeySetup: false },
            { provider: "unconfigured-model", apiKeySupported: true, quickApiKeySetup: true },
          ],
        ),
      });
      expect(cards).toHaveLength(1);
      expect(firstCard(cards)).toMatchObject({
        id: "model-service",
        modelCount: 0,
        apiKeySupported,
        apiKey: { source: "env", envVar: "MODEL_SERVICE_API_KEY" },
        credentialProviderIds: ["model-service"],
      });
    },
  );

  const outcome = (
    status: ModelCatalogProviderOutcome["status"],
    profileId?: string,
  ): ModelCatalogProviderOutcome => ({
    provider: "openai",
    status,
    ...(profileId ? { profileId } : {}),
  });
  it.each<[string, ModelCatalogProviderOutcome[], ModelCatalogProviderOutcome["status"]]>([
    [
      "keeps a ready profile above a rejected sibling",
      [outcome("auth-rejected", "rejected"), outcome("ready", "ready")],
      "ready",
    ],
    [
      "keeps an unscoped rejection above a ready profile",
      [outcome("auth-rejected"), outcome("ready", "ready")],
      "auth-rejected",
    ],
    [
      "keeps unscoped readiness above a rejected profile",
      [outcome("ready"), outcome("auth-rejected", "rejected")],
      "ready",
    ],
    [
      "reports the worst unscoped diagnostic",
      [outcome("ready"), outcome("unavailable")],
      "unavailable",
    ],
  ])("%s in either input order", (_name, outcomes, expected) => {
    for (const ordered of [outcomes, outcomes.toReversed()]) {
      const cards = buildCards({ providerOutcomes: ordered });
      expect(cards).toHaveLength(1);
      expect(firstCard(cards).catalogStatus).toBe(expected);
    }
  });

  it("merges CLI alias auth rows into the canonical provider card", () => {
    const cards = buildCards({
      models: [catalogEntry({ provider: "anthropic", available: true })],
      authStatus: authStatus([
        provider("claude-cli", "Claude", {
          profiles: [profile("p1")],
          usage: {
            providerId: "anthropic",
            windows: [{ label: "5h", usedPercent: 40 }],
            plan: "Max",
          },
        }),
      ]),
    });
    expect(cards).toHaveLength(1);
    expect(firstCard(cards)).toMatchObject({
      id: "anthropic",
      credentialProviderIds: ["claude-cli"],
      displayName: "Claude",
      auth: { kind: "ok" },
    });
    expect(firstCard(cards).usage).toMatchObject({
      provider: "anthropic",
      plan: "Max",
      windows: [{ label: "5h", usedPercent: 40 }],
    });
  });

  it("keeps the most urgent auth state when alias rows share a card", () => {
    const cards = authCards([
      provider("anthropic", "Claude", {
        profiles: [profile("p1", "ok", true)],
        usage: { providerId: "anthropic", windows: [] },
      }),
      provider("claude-cli", "Claude", {
        status: "expired",
        expiry: { at: 1, remainingMs: -1, label: "-1m" },
        profiles: [profile("p2", "expired", true)],
        usage: { providerId: "anthropic", windows: [] },
      }),
    ]);
    expect(cards).toHaveLength(1);
    expect(firstCard(cards).auth).toMatchObject({
      kind: "expired",
      expiryLabel: "-1m",
    });
    expect(firstCard(cards).credentialProviderIds).toEqual(["anthropic", "claude-cli"]);
    expect(firstCard(cards).logoutTargets).toEqual([
      { provider: "anthropic", profileIds: ["p1"] },
      { provider: "claude-cli", profileIds: ["p2"] },
    ]);
  });

  it("groups alias profile priority under the shared auth owner", () => {
    const cards = authCards([
      provider("anthropic", "Claude", {
        authProvider: "anthropic",
        profiles: [profile("p1")],
        profileOrder: ["p2", "p1"],
        profileOrderStored: true,
        profileOrderLocked: "provider-config",
      }),
      provider("claude-cli", "Claude", {
        authProvider: "anthropic",
        profiles: [profile("p2")],
        profileOrder: ["p2", "p1"],
        profileOrderStored: true,
      }),
    ]);

    expect(firstCard(cards)).toMatchObject({
      profileProviderIds: { p1: "anthropic", p2: "anthropic" },
      profileOrders: { anthropic: ["p2", "p1"] },
      profileOrderExplicitProviders: ["anthropic"],
      profileOrderStoredProviders: ["anthropic"],
      profileOrderLocks: { anthropic: "provider-config" },
    });
  });

  it("keeps a credential-less missing route visible beside CLI OAuth", () => {
    const cards = authCards([
      provider("anthropic", "Claude", {
        status: "missing",
        profiles: [],
      }),
      provider("claude-cli", "Claude", {
        status: "expiring",
        profiles: [profile("anthropic:claude-cli", "expiring")],
      }),
    ]);

    expect(firstCard(cards).auth).toMatchObject({ kind: "missing" });
  });

  it("prefers usage.status snapshots over the auth-status embed", () => {
    const cards = buildCards({
      authStatus: authStatus([
        provider("openai", "OpenAI", {
          profiles: [profile("p1")],
          usage: { providerId: "openai", windows: [{ label: "5h", usedPercent: 10 }] },
        }),
      ]),
      providerUsage: {
        updatedAt: 2,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [{ label: "5h", usedPercent: 55 }],
            costHistory: {
              unit: "USD",
              periodDays: 30,
              daily: [],
              models: [],
              categories: [],
            },
          },
        ],
      },
    });
    expect(cards).toHaveLength(1);
    expect(firstCard(cards).usage?.windows).toEqual([{ label: "5h", usedPercent: 55 }]);
    expect(firstCard(cards).usage?.costHistory?.periodDays).toBe(30);
  });

  it("attaches local session spend via alias ids and includes cost-only providers", () => {
    const totals = {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      totalCost: 0.42,
      inputCost: 0.3,
      outputCost: 0.12,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    };
    const cards = buildCards({
      authStatus: authStatus([
        provider("claude-cli", "Claude", {
          usage: { providerId: "anthropic", windows: [] },
        }),
      ]),
      costByProvider: [
        { provider: "anthropic", count: 3, totals },
        { provider: "openrouter", count: 1, totals },
      ],
    });
    expect(cards.map((card) => card.id)).toEqual(["anthropic", "openrouter"]);
    expect(firstCard(cards).localCost).toEqual({
      totalCost: 0.42,
      totalTokens: 150,
      messageCount: 3,
    });
  });

  it("keeps API key provenance and config-only providers", () => {
    const cards = buildCards({
      configProviders: [
        { key: "mistral", hasApiKey: false },
        { key: "OpenAI", hasApiKey: true, authMode: "api-key" },
      ],
      authStatus: authStatus([
        provider("openai", "OpenAI", {
          status: "static",
          profiles: [],
          apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
        }),
      ]),
    });
    expect(cards.map((card) => card.id)).toEqual(["mistral", "openai"]);
    expect(cards[1]).toMatchObject({
      apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
      configKey: "OpenAI",
      configAuthMode: "api-key",
      credentialProviderIds: ["OpenAI"],
      hasConfigApiKey: true,
      profiles: [],
    });
  });
});

describe("model provider configuration data", () => {
  it("keeps a fresh restricted catalog's default authoritative over a draft", () => {
    const configured = {
      primary: "openai/configured-model",
      fallbacks: [],
      utilityModel: null,
      thinkingLevel: undefined,
      thinkingOverridden: false,
      fastMode: undefined,
      fastModeOverridden: false,
    };
    const presentation = resolveDefaultModelPresentation(
      {
        models: [
          catalogEntry({ provider: "openai", id: "allowed-model", available: true }),
          catalogEntry({
            provider: "openai",
            id: "hidden-model",
            manualSelectionAllowed: false,
          }),
        ],
        hasSnapshot: true,
        retired: false,
        modelSelectionPolicy: { restricted: true, defaultModel: "openai/allowed-model" },
      },
      configured,
      { ...configured, primary: "openai/draft-model", fallbacks: ["openai/draft-fallback"] },
    );

    expect(presentation.defaults).toEqual({
      ...configured,
      primary: "openai/allowed-model",
      decisionModel: null,
    });
    expect(presentation.configuredModels.map(modelCatalogRef)).toEqual(["openai/allowed-model"]);
  });

  it("offers usable defaults while preserving saved unavailable refs", () => {
    const models = [
      catalogEntry({ provider: "openai", id: "gpt-ready", available: true }),
      catalogEntry({ provider: "openai", id: "gpt-disabled", available: false }),
    ];
    const selectable = defaultModelChoices(models, {
      primary: "openai/gpt-saved",
      fallbacks: ["openai/gpt-disabled"],
      utilityModel: { primary: "openai/utility", fallbacks: ["openai/utility-backup"] },
    });
    expect(selectable.map((model) => `${model.provider}/${model.id}`)).toEqual([
      "openai/gpt-ready",
      "openai/gpt-disabled",
      "openai/gpt-saved",
      "openai/utility",
      "openai/utility-backup",
    ]);
  });

  it("keeps saved models available when the catalog is unknown, but not when it is empty", () => {
    const selection = { primary: "saved-model", fallbacks: [], utilityModel: null };
    expect(defaultModelChoices(null, selection)[0]).not.toHaveProperty("available");
    expect(defaultModelChoices([], selection)[0]).toMatchObject({ available: false });
  });

  it("preserves alias-valued and bare model defaults as picker options", () => {
    const selectable = defaultModelChoices(
      [catalogEntry({ provider: "anthropic", id: "claude-opus", alias: "Opus", available: true })],
      { primary: "opus", fallbacks: ["unknown-model"], utilityModel: null },
    );
    expect(selectable.map(modelCatalogRef)).toEqual([
      "anthropic/claude-opus",
      "opus",
      "unknown-model",
    ]);
  });

  it("reads string and object model defaults", () => {
    expect(
      readModelProviderConfig({
        models: {
          providers: {
            openai: providerConfig(redactedConfigValue),
            anthropic: { auth: "oauth" },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5",
              fallbacks: ["anthropic/claude-sonnet-4-5", 42],
            },
            utilityModel: "openai/gpt-5-mini",
          },
        },
      }),
    ).toEqual({
      providers: [
        { key: "openai", hasApiKey: true },
        { key: "anthropic", hasApiKey: false, authMode: "oauth" },
      ],
      defaults: {
        primary: "openai/gpt-5",
        fallbacks: ["anthropic/claude-sonnet-4-5"],
        utilityModel: "openai/gpt-5-mini",
      },
    });
    expect(
      readModelProviderConfig({ agents: { defaults: { model: "openai/gpt-5" } } }).defaults,
    ).toEqual({ primary: "openai/gpt-5", fallbacks: [], utilityModel: null });
    expect(
      readModelProviderConfig({ agents: { defaults: { utilityModel: "" } } }).defaults.utilityModel,
    ).toBe("");
  });

  it("lists known providers that are not configured", () => {
    const options = buildUnconfiguredProviderOptions(
      [
        { provider: "openai", apiKeySupported: true, quickApiKeySetup: true },
        { provider: "anthropic", apiKeySupported: true, quickApiKeySetup: true },
        { provider: "github-copilot", apiKeySupported: true, quickApiKeySetup: false },
      ],
      ["openai"],
    );
    expect(options).toEqual([{ id: "anthropic", displayName: "Anthropic" }]);
  });
});
