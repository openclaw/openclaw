// @vitest-environment node
import { expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import type {
  ModelAuthStatusProvider,
  ModelAuthStatusResult,
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

function model(id: string, overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return { provider: "openai", id, name: "Model", available: false, ...overrides };
}
function provider(
  id: string,
  overrides: Partial<ModelAuthStatusProvider> = {},
): ModelAuthStatusProvider {
  return { provider: id, displayName: id, status: "ok", profiles: [], ...overrides };
}
function keyProvider(id: string, envVar: string, extra: Partial<ModelAuthStatusProvider> = {}) {
  return provider(id, { status: "static", apiKey: { source: "env", envVar }, ...extra });
}
function capability(id: string, quickApiKeySetup = true) {
  return { provider: id, apiKeySupported: true, quickApiKeySetup };
}
function usage(providerId: string, usedPercent?: number, plan?: string) {
  return {
    providerId,
    windows: usedPercent === undefined ? [] : [{ label: "5h", usedPercent }],
    plan,
  };
}
function profile(
  profileId: string,
  status: "ok" | "expired" | "expiring" = "ok",
  logoutSupported?: boolean,
) {
  return { profileId, type: "oauth" as const, status, logoutSupported };
}
type CardsInput = Parameters<typeof buildModelProviderCards>[0];
function input(
  providers: ModelAuthStatusProvider[],
  extra: Partial<CardsInput> = {},
  providerCapabilities?: ModelAuthStatusResult["providerCapabilities"],
): CardsInput {
  return {
    authStatus: { ts: 1, providers, providerCapabilities },
    models: null,
    providerUsage: null,
    costByProvider: null,
    ...extra,
  };
}
function build(...args: Parameters<typeof input>) {
  return buildModelProviderCards(input(...args));
}
function modelSelection(
  primary: string,
  fallbacks: string[] = [],
  utilityModel: DefaultModelSelection["utilityModel"] = null,
) {
  return { primary, fallbacks, utilityModel };
}
function defaults(selection: DefaultModelSelection) {
  return {
    ...selection,
    thinkingLevel: undefined,
    thinkingOverridden: false,
    fastMode: undefined,
    fastModeOverridden: false,
  };
}
function choices(models: ModelCatalogEntry[] | null, selection: DefaultModelSelection) {
  return resolveDefaultModelPresentation(
    { models: models ?? [], hasSnapshot: models !== null, retired: false },
    defaults(selection),
    null,
  ).configuredModels;
}
const outcome = (
  status: ModelCatalogProviderOutcome["status"],
  profileId?: string,
): ModelCatalogProviderOutcome => ({
  provider: "openai",
  status,
  ...(profileId ? { profileId } : {}),
});

it("retains model-service environment auth but excludes tool-only credentials", () => {
  const cards = build(
    [
      keyProvider("model-service", "MODEL_SERVICE_API_KEY"),
      keyProvider("web-search", "WEB_SEARCH_API_KEY", {
        profiles: [{ profileId: "search", type: "api_key", status: "static" }],
      }),
    ],
    {},
    [capability("model-service", false), capability("unconfigured-model")],
  );
  expect(cards).toMatchObject([
    {
      id: "model-service",
      modelCount: 0,
      apiKeySupported: true,
      apiKey: { source: "env", envVar: "MODEL_SERVICE_API_KEY" },
      credentialProviderIds: ["model-service"],
    },
  ]);
});

it.each<[string, ModelCatalogProviderOutcome[], ModelCatalogProviderOutcome["status"]]>([
  [
    "ready profile beats rejected sibling",
    [outcome("auth-rejected", "rejected"), outcome("ready", "ready")],
    "ready",
  ],
  [
    "unscoped rejection beats ready profile",
    [outcome("auth-rejected"), outcome("ready", "ready")],
    "auth-rejected",
  ],
  [
    "unscoped readiness beats rejected profile",
    [outcome("ready"), outcome("auth-rejected", "rejected")],
    "ready",
  ],
  ["worst unscoped diagnostic wins", [outcome("ready"), outcome("unavailable")], "unavailable"],
])("%s in either input order", (_name, outcomes, expected) => {
  for (const ordered of [outcomes, outcomes.toReversed()]) {
    expect(build([], { authStatus: null, providerOutcomes: ordered })).toMatchObject([
      { catalogStatus: expected },
    ]);
  }
});

it.each<[string, CardsInput, unknown[]]>([
  [
    "merges CLI aliases with canonical models and usage",
    input(
      [
        provider("claude-cli", {
          displayName: "Claude",
          profiles: [profile("p1")],
          usage: usage("anthropic", 40, "Max"),
        }),
      ],
      { models: [model("anthropic/model", { provider: "anthropic", available: true })] },
    ),
    [
      {
        id: "anthropic",
        credentialProviderIds: ["claude-cli"],
        displayName: "Claude",
        auth: { kind: "ok" },
        usage: {
          provider: "anthropic",
          plan: "Max",
          windows: [{ label: "5h", usedPercent: 40 }],
        },
      },
    ],
  ],
  [
    "keeps urgent alias auth and each logout owner",
    input([
      provider("anthropic", {
        profiles: [profile("p1", "ok", true)],
      }),
      provider("claude-cli", {
        status: "expired",
        expiry: { at: 1, remainingMs: -1, label: "-1m" },
        profiles: [profile("p2", "expired", true)],
      }),
    ]),
    [
      {
        auth: { kind: "expired", expiryLabel: "-1m" },
        credentialProviderIds: ["anthropic", "claude-cli"],
        logoutTargets: [
          { provider: "anthropic", profileIds: ["p1"] },
          { provider: "claude-cli", profileIds: ["p2"] },
        ],
      },
    ],
  ],
  [
    "groups alias priority under the shared auth owner",
    input(
      ["anthropic", "claude-cli"].map((id, index) =>
        provider(id, {
          authProvider: "anthropic",
          profiles: [profile(`p${index + 1}`)],
          profileOrder: ["p2", "p1"],
          profileOrderStored: true,
          ...(index === 0 ? { profileOrderLocked: "provider-config" as const } : {}),
        }),
      ),
    ),
    [
      {
        profileProviderIds: { p1: "anthropic", p2: "anthropic" },
        profileOrders: { anthropic: ["p2", "p1"] },
        profileOrderExplicitProviders: ["anthropic"],
        profileOrderStoredProviders: ["anthropic"],
        profileOrderLocks: { anthropic: "provider-config" },
      },
    ],
  ],
  [
    "keeps a credential-less missing route beside CLI OAuth",
    input([
      provider("anthropic", { status: "missing" }),
      provider("claude-cli", {
        status: "expiring",
        profiles: [profile("anthropic:claude-cli", "expiring")],
      }),
    ]),
    [{ auth: { kind: "missing" } }],
  ],
  [
    "keeps API-key provenance and config-only providers",
    input([keyProvider("openai", "OPENAI_API_KEY")], {
      configProviders: [
        { key: "mistral", hasApiKey: false },
        { key: "OpenAI", hasApiKey: true, authMode: "api-key" },
      ],
    }),
    [
      { id: "mistral" },
      {
        id: "openai",
        apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
        configKey: "OpenAI",
        configAuthMode: "api-key",
        credentialProviderIds: ["OpenAI"],
        hasConfigApiKey: true,
        profiles: [],
      },
    ],
  ],
])("%s", (_name, data, expected) => {
  expect(buildModelProviderCards(data)).toMatchObject(expected);
});

it("prefers usage.status snapshots over the auth-status embed", () => {
  const cards = build([provider("openai", { usage: usage("openai", 10) })], {
    providerUsage: {
      updatedAt: 2,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 55 }],
          costHistory: { unit: "USD", periodDays: 30, daily: [], models: [], categories: [] },
        },
      ],
    },
  });
  expect(cards).toMatchObject([
    {
      usage: {
        windows: [{ label: "5h", usedPercent: 55 }],
        costHistory: { periodDays: 30 },
      },
    },
  ]);
});

it("attaches local spend through aliases and includes cost-only providers", () => {
  const totals = { ...createEmptyCostUsageTotals(), totalTokens: 150, totalCost: 0.42 };
  const cards = build([provider("claude-cli")], {
    costByProvider: [
      { provider: "anthropic", count: 3, totals },
      { provider: "openrouter", count: 1, totals },
    ],
  });
  expect(cards).toMatchObject([
    { id: "anthropic", localCost: { totalCost: 0.42, totalTokens: 150, messageCount: 3 } },
    { id: "openrouter" },
  ]);
});
it("keeps a fresh restricted catalog authoritative over a draft", () => {
  const configured = defaults(modelSelection("openai/configured-model"));
  const presentation = resolveDefaultModelPresentation(
    {
      models: [
        model("allowed-model", { available: true }),
        model("hidden-model", { manualSelectionAllowed: false }),
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

it.each([
  {
    name: "preserves saved unavailable refs and utility chains",
    models: [model("ready", { available: true }), model("disabled")],
    selection: modelSelection("openai/saved", ["openai/disabled"], {
      primary: "openai/utility",
      fallbacks: ["openai/backup"],
    }),
    expected: [
      "openai/ready",
      "openai/disabled",
      "openai/saved",
      "openai/utility",
      "openai/backup",
    ],
  },
  {
    name: "preserves alias-valued and bare model defaults",
    models: [model("claude-opus", { provider: "anthropic", alias: "Opus", available: true })],
    selection: modelSelection("opus", ["unknown-model"]),
    expected: ["anthropic/claude-opus", "opus", "unknown-model"],
  },
])("$name", ({ models, selection, expected }) => {
  expect(choices(models, selection).map(modelCatalogRef)).toEqual(expected);
});

it("distinguishes unknown and empty catalogs for saved models", () => {
  const saved = modelSelection("saved-model");
  expect(choices(null, saved)[0]).not.toHaveProperty("available");
  expect(choices([], saved)[0]).toMatchObject({ available: false });
});

it("reads string and object defaults and preserves disabled utility", () => {
  const read = (values: Record<string, unknown>, providers = {}) =>
    readModelProviderConfig({ models: { providers }, agents: { defaults: values } });
  expect(
    read(
      {
        model: { primary: "openai/main", fallbacks: ["anthropic/fallback", 42] },
        utilityModel: "openai/utility",
      },
      { openai: { apiKey: "[redacted]" }, anthropic: { auth: "oauth" } },
    ),
  ).toEqual({
    providers: [
      { key: "openai", hasApiKey: true },
      { key: "anthropic", hasApiKey: false, authMode: "oauth" },
    ],
    defaults: {
      primary: "openai/main",
      fallbacks: ["anthropic/fallback"],
      utilityModel: "openai/utility",
    },
  });
  expect(read({ model: "openai/main" }).defaults).toEqual(modelSelection("openai/main"));
  expect(read({ utilityModel: "" }).defaults.utilityModel).toBe("");
});

it("offers only unconfigured providers with quick API-key setup", () => {
  expect(
    buildUnconfiguredProviderOptions(
      [capability("openai"), capability("anthropic"), capability("github-copilot", false)],
      ["openai"],
    ),
  ).toEqual([{ id: "anthropic", displayName: "Anthropic" }]);
});
