import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveStatusUtilityModel } from "../commands/models/list.status-utility.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createModelRuntimeChoiceOwnerFixture } from "./model-runtime-choice.test-support.js";
import * as preparedCatalog from "./prepared-model-catalog.js";
import { resolveSimpleCompletionSelectionForAgent } from "./simple-completion-selection.js";
import { makeProviderModelsConfigFixture } from "./test-helpers/provider-model-fixture.js";
import {
  resolveAutomaticUtilityRuntimeOverride,
  resolveConfiguredSetupModelForAgent,
  resolveUtilityModelRefForAgent,
} from "./utility-model.js";

/** A string declares the provider's small model; a map declares a router's per-vendor models. */
function snapshotWithDefaults(defaults: Record<string, string | Record<string, string>>) {
  return createPluginMetadataSnapshotFixture({
    plugins: Object.entries(defaults).map(([provider, utility], index) => ({
      id: `plugin-${index}`,
      modelCatalog: {
        providers: {
          [provider]:
            typeof utility === "string"
              ? { defaultUtilityModel: utility, models: [{ id: utility }] }
              : { defaultUtilityModels: utility, models: [] },
        },
      },
    })),
  });
}

describe("resolveConfiguredSetupModelForAgent", () => {
  it.each([
    { utilityModel: undefined, expected: undefined },
    { utilityModel: "", expected: undefined },
    {
      utilityModel: "local-utility/shared",
      agentId: "ops",
      expected: { modelRef: "local-utility/ops", modelTarget: "utility" },
    },
    { utilityModel: "local-utility/shared", agentId: "disabled", expected: undefined },
    {
      utilityModel: " local-utility/tiny@local-utility:setup ",
      expected: { modelRef: "local-utility/tiny@local-utility:setup", modelTarget: "utility" },
    },
  ])(
    "uses only an enabled utility setting for setup: %j",
    ({ utilityModel, expected, agentId = "main" }) => {
      const cfg: OpenClawConfig = {
        meta: { migrations: { utilityModelSeparation: true } },
        agents: {
          ownership: "explicit",
          defaults: { utilityModel },
          entries: { ops: { utilityModel: "local-utility/ops" }, disabled: { utilityModel: "" } },
        },
      };
      expect(resolveConfiguredSetupModelForAgent({ cfg, agentId })).toEqual(expected);
      cfg.agents!.defaults!.model = "openai/gpt-5.5";
      expect(resolveConfiguredSetupModelForAgent({ cfg, agentId, modelTarget: "utility" })).toEqual(
        expected,
      );
    },
  );

  it.each([false, true])(
    "keeps the native primary for setup unless utility is selected (ACP=%s)",
    (acp) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { model: "openai/gpt-5.5@openai:primary", utilityModel: "local-utility/tiny" },
          entries: { main: acp ? { model: "harness-only", runtime: { type: "acp" } } : {} },
        },
      };
      expect(resolveConfiguredSetupModelForAgent({ cfg, agentId: "main" })).toEqual({
        modelRef: "openai/gpt-5.5@openai:primary",
      });
      expect(
        resolveConfiguredSetupModelForAgent({ cfg, agentId: "main", modelTarget: "utility" }),
      ).toEqual({ modelRef: "local-utility/tiny", modelTarget: "utility" });
    },
  );

  it.each(["local-utility/tiny@local:utility", "helper@local:utility"])(
    "keeps the legacy implicit primary for setup alongside utility ref %s",
    (utilityModel) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            utilityModel,
            models: { "local-utility/tiny": { alias: "helper" } },
          },
        },
        models: makeProviderModelsConfigFixture({
          id: "tiny",
          provider: "local-utility",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:9/v1",
        }),
      };
      const original = structuredClone(cfg);
      expect(resolveConfiguredSetupModelForAgent({ cfg, agentId: "main" })).toEqual({
        modelRef: "local-utility/tiny",
        implicitPrimary: true,
      });
      expect(
        resolveConfiguredSetupModelForAgent({ cfg, agentId: "main", modelTarget: "utility" }),
      ).toEqual({ modelRef: utilityModel, modelTarget: "utility" });
      expect(cfg).toEqual(original);
    },
  );
});

describe("resolveUtilityModelRefForAgent", () => {
  const metadataSnapshot = snapshotWithDefaults({
    openai: "gpt-5.6-luna",
    anthropic: "claude-haiku-4-5",
    router: { openai: "openai/luna", anthropic: "anthropic/haiku", google: "google/flash" },
  });
  // The router credential's inventory does not grant google/flash.
  const catalog = {
    entries: ["openai/luna", "anthropic/haiku"].map((id) => ({ provider: "router", id })),
  };
  const sharedWithOptOut = {
    agents: {
      defaults: { utilityModel: "openai/gpt-5.4-mini" },
      entries: { ops: { utilityModel: "" } },
    },
  };
  type Scenario = Omit<
    Parameters<typeof resolveUtilityModelRefForAgent>[0],
    "agentId" | "metadataSnapshot"
  > & { name: string; agentId?: string; expected?: string };
  it.each<Scenario>([
    {
      name: "trimmed explicit reference",
      cfg: { agents: { defaults: { utilityModel: " openrouter/mistralai/mistral-small " } } },
      expected: "openrouter/mistralai/mistral-small",
    },
    { name: "disabled", cfg: { agents: { defaults: { utilityModel: "   " } } } },
    {
      name: "provider default",
      cfg: { agents: { defaults: { model: "anthropic/claude-fable-5" } } },
      expected: "anthropic/claude-haiku-4-5",
    },
    {
      name: "native auth profile",
      cfg: { agents: { defaults: { model: "openai/gpt-5.5@work" }, entries: { main: {} } } },
      expected: "openai/gpt-5.6-luna@work",
    },
    {
      name: "ACP preserves native auth profile",
      cfg: {
        agents: {
          defaults: { model: "openai/gpt-5.5@work" },
          entries: { main: { model: "harness-only@harness-profile", runtime: { type: "acp" } } },
        },
      },
      expected: "openai/gpt-5.6-luna@work",
    },
    {
      name: "session auth overrides primary",
      cfg: { agents: { defaults: { model: "anthropic/claude-fable-5@personal" } } },
      primaryProvider: "OpenAI",
      primaryModelRef: "openai/gpt-5.5@work",
      expected: "openai/gpt-5.6-luna@work",
    },
    { name: "no provider default", cfg: { agents: { defaults: { model: "ollama/llama-4-70b" } } } },
    { name: "agent opt-out", cfg: sharedWithOptOut, agentId: "ops" },
    { name: "shared model for others", cfg: sharedWithOptOut, expected: "openai/gpt-5.4-mini" },
    { name: "router default", cfg: routed("openai/sol"), catalog, expected: "router/openai/luna" },
    { name: "router vendor without a declaration", cfg: routed("mistral/large"), catalog },
    { name: "router declaration not granted", cfg: routed("google/pro"), catalog },
    { name: "router without a known catalog", cfg: routed("openai/sol") },
    {
      name: "router decision-only row",
      cfg: routed("openai/sol"),
      catalog: { entries: [{ provider: "router", id: "openai/luna", inference: { chat: false } }] },
    },
    {
      name: "router session vendor and auth profile",
      cfg: routed("openai/sol"),
      primaryProvider: "router",
      primaryModelRef: "router/anthropic/opus@work",
      catalog,
      expected: "router/anthropic/haiku@work",
    },
  ])("resolves $name", ({ expected, agentId = "main", ...params }) => {
    expect(resolveUtilityModelRefForAgent({ ...params, agentId, metadataSnapshot })).toBe(expected);
  });
});

it("retains automatic ownership when a lazy catalog read fails", () => {
  expect(
    resolveUtilityModelRefForAgent({
      cfg: { agents: { defaults: { model: "fixture/primary@work" } } },
      agentId: "main",
      catalog: {
        providerOutcomes: [{ provider: "fixture", profileId: "work", status: "ready" }],
        get entries(): never {
          throw new Error("catalog acquisition failed");
        },
      },
      metadataSnapshot: snapshotWithDefaults({ fixture: "small" }),
    }),
  ).toBe("fixture/small@work");
});

it("resolves the shipped supported OpenAI utility default", () => {
  const loaded = loadPluginManifest(path.join(process.cwd(), "extensions/openai"));
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  expect(
    resolveUtilityModelRefForAgent({
      cfg: { agents: { defaults: { model: "openai/gpt-6-sol@work" } } },
      agentId: "main",
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [{ id: "openai", modelCatalog: loaded.manifest.modelCatalog }],
      }),
    }),
  ).toBe("openai/gpt-6-luna@work");
});

it.each([
  { name: "missing default", ids: ["primary"], expected: "fixture/primary@work" },
  { name: "available default", ids: ["small", "primary"], expected: "fixture/small@work" },
  {
    name: "another account model row",
    ids: ["small", "primary"],
    listedIds: ["primary"],
    expected: "fixture/primary@work",
  },
  { name: "no offered recovery", ids: ["other"], expected: "fixture/small@work" },
  {
    name: "failed provider with retained rows",
    ids: ["primary"],
    unpinned: true,
    outcomeStatus: "unavailable" as const,
    expected: "fixture/small",
  },
  {
    name: "unrelated provider failure",
    ids: ["primary"],
    foreignFailure: true,
    expected: "fixture/primary@work",
  },
  {
    name: "another account catalog",
    ids: ["primary"],
    catalogProfile: "personal",
    expected: "fixture/small@work",
  },
  {
    name: "configured unavailable default",
    ids: ["primary"],
    unavailable: true,
    expected: "fixture/primary@work",
  },
  {
    name: "unavailable first fallback",
    ids: ["backup", "primary"],
    expected: "fixture/backup@work",
  },
  {
    name: "failed catalog",
    ids: ["primary"],
    authoritative: false,
    expected: "fixture/small@work",
  },
  {
    name: "synthetic default",
    ids: ["primary"],
    synthetic: true,
    expected: "fixture/primary@work",
  },
])(
  "automatic utility selection respects $name",
  ({
    ids,
    authoritative,
    synthetic,
    unavailable,
    catalogProfile,
    listedIds,
    unpinned,
    outcomeStatus,
    foreignFailure,
    expected,
  }) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: unpinned ? "fixture/primary" : "fixture/primary@work",
          utilityModel: { fallbacks: ["fixture/missing", "fixture/backup"] },
        },
      },
    };
    const catalog = {
      entries: [
        ...ids.map((id) => ({ provider: "fixture", id })),
        ...(unavailable ? [{ provider: "fixture", id: "small", available: false }] : []),
        ...(synthetic
          ? [
              {
                provider: "fixture",
                id: "small",
                contextCapacitySource: "unaccepted-starter" as const,
              },
            ]
          : []),
      ],
      authoritative,
      providerOutcomes: [
        {
          provider: "fixture",
          profileId: unpinned ? undefined : (catalogProfile ?? "work"),
          status: outcomeStatus ?? ("ready" as const),
          listedModelIds: listedIds,
        },
        ...(foreignFailure ? [{ provider: "other", status: "unavailable" as const }] : []),
      ],
    };
    expect(
      resolveUtilityModelRefForAgent({
        cfg,
        agentId: "main",
        catalog,
        metadataSnapshot: snapshotWithDefaults({ fixture: "small" }),
      }),
    ).toBe(expected);
    cfg.agents!.defaults!.utilityModel = "fixture/missing@explicit";
    expect(resolveUtilityModelRefForAgent({ cfg, agentId: "main", catalog })).toBe(
      "fixture/missing@explicit",
    );
  },
);

it.each([
  { fallback: "gpt-6-luna", provider: "openai", modelId: "gpt-6-luna" },
  { fallback: "openai/gpt-6-luna", provider: "openai", modelId: "gpt-6-luna" },
  { fallback: "budget", provider: "openai", modelId: "gpt-6-luna" },
  {
    fallback: "gpt-6-luna@backup",
    provider: "openai",
    modelId: "gpt-6-luna",
    profileId: "backup",
  },
  { fallback: "anthropic/backup", provider: "anthropic", modelId: "backup", profileId: "session" },
  { fallback: "gpt-6-luna", provider: "openai", modelId: "gpt-6-luna", agentOverride: true },
  {
    fallback: "gpt-6-luna",
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    profileId: "session",
    unavailable: true,
  },
])(
  "executes Auto fallback $fallback in its configured provider context ($agentOverride)",
  (expected) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: expected.agentOverride ? "other/primary" : "openai/gpt-6-sol@primary",
          models: { "gpt-6-luna": { alias: "budget" } },
          utilityModel: { fallbacks: [expected.fallback] },
        },
        ...(expected.agentOverride
          ? { entries: { main: { model: "openai/gpt-6-sol@primary" } } }
          : {}),
      },
    };
    const metadataSnapshot = snapshotWithDefaults({
      openai: "gpt-6-luna",
      anthropic: "claude-haiku-4-5",
    });
    const modelRef = resolveUtilityModelRefForAgent({
      cfg,
      agentId: "main",
      primaryProvider: "anthropic",
      primaryModelRef: "anthropic/claude-sonnet-4-5@session",
      catalog: {
        entries: [
          { provider: "openai", id: "gpt-6-luna", available: !expected.unavailable },
          ...(expected.unavailable ? [{ provider: "anthropic", id: "gpt-6-luna" }] : []),
          { provider: "anthropic", id: "claude-sonnet-4-5" },
          { provider: "anthropic", id: "backup" },
        ],
        providerOutcomes: [
          {
            provider: "openai",
            profileId: "backup",
            status: "ready",
            listedModelIds: ["gpt-6-luna"],
          },
          { provider: "anthropic", profileId: "session", status: "ready" },
        ],
      },
      metadataSnapshot,
    });
    expect(
      resolveSimpleCompletionSelectionForAgent({
        cfg,
        agentId: "main",
        modelRef,
        useUtilityModel: "required",
        manifestPlugins: metadataSnapshot,
      }),
    ).toMatchObject({
      provider: expected.provider,
      modelId: expected.modelId,
      profileId: expected.profileId,
    });
  },
);

it("keeps an automatically selected configured fallback on its own runtime", () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: "anthropic/primary@work",
        models: { "anthropic/primary": { agentRuntime: { id: "claude-cli" } } },
        utilityModel: { fallbacks: ["anthropic/backup"] },
      },
    },
  };
  const metadataSnapshot = snapshotWithDefaults({ anthropic: "small" });
  const owner = createModelRuntimeChoiceOwnerFixture(cfg, () => true, {
    metadataSnapshot,
    modelCatalog: {
      entries: [{ provider: "anthropic", id: "backup", name: "Backup" }],
      routeVariants: [],
      providerOutcomes: [{ provider: "anthropic", profileId: "work", status: "ready" }],
    },
  });
  using published = vi
    .spyOn(preparedCatalog, "getPublishedPreparedModelCatalogOwnerSnapshot")
    .mockReturnValue(owner);
  expect(resolveStatusUtilityModel({ cfg, agentId: "main" })).toMatchObject({
    ref: "anthropic/backup@work",
    source: "config",
  });
  expect(
    resolveAutomaticUtilityRuntimeOverride({
      cfg,
      agentId: "main",
      utilityProvider: "anthropic",
      utilityModelId: "backup",
      metadataSnapshot,
    }),
  ).toBeUndefined();
  published.mockReturnValue({
    ...owner,
    modelCatalog: {
      ...owner.modelCatalog,
      providerOutcomes: [{ provider: "anthropic", profileId: "personal", status: "ready" }],
    },
  });
  expect(resolveUtilityModelRefForAgent({ cfg, agentId: "main", metadataSnapshot })).toBe(
    "anthropic/small@work",
  );
  expect(
    resolveAutomaticUtilityRuntimeOverride({
      cfg,
      agentId: "main",
      utilityProvider: "anthropic",
      utilityModelId: "small",
      metadataSnapshot,
    }),
  ).toBe("claude-cli");
});

it("normalizes a primary alias only once when Auto recovers to that primary", () => {
  const cfg: OpenClawConfig = { agents: { defaults: { model: "fixture/entry@work" } } };
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "fixture",
        providers: ["fixture"],
        modelIdNormalization: {
          providers: { fixture: { aliases: { entry: "middle", middle: "final" } } },
        },
        modelCatalog: { providers: { fixture: { defaultUtilityModel: "small", models: [] } } },
      },
    ],
  });
  const owner = createModelRuntimeChoiceOwnerFixture(cfg, () => true, {
    metadataSnapshot,
    modelCatalog: {
      entries: [{ provider: "fixture", id: "middle", name: "Middle" }],
      routeVariants: [],
      providerOutcomes: [
        { provider: "fixture", profileId: "work", status: "ready", listedModelIds: ["middle"] },
      ],
    },
  });
  using published = vi.spyOn(preparedCatalog, "getPublishedPreparedModelCatalogOwnerSnapshot");
  published.mockReturnValue(owner);
  const modelRef = resolveUtilityModelRefForAgent({ cfg, agentId: "main", metadataSnapshot });
  expect(
    resolveSimpleCompletionSelectionForAgent({
      cfg,
      agentId: "main",
      modelRef,
      useUtilityModel: "required",
      manifestPlugins: metadataSnapshot,
    }),
  ).toMatchObject({
    provider: "fixture",
    modelId: "middle",
    profileId: "work",
  });
});

function routed(model: string): OpenClawConfig {
  return { agents: { defaults: { model: `router/${model}` } } };
}

describe("resolveAutomaticUtilityRuntimeOverride", () => {
  const primary = "anthropic/claude-opus-5";
  const utility = "anthropic/claude-haiku-4-5";
  const cliEntry = { agentRuntime: { id: "claude-cli" } };
  const metadataSnapshot = snapshotWithDefaults({ anthropic: "claude-haiku-4-5" });
  type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
  type Scenario = {
    name: string;
    defaults?: Defaults;
    providers?: NonNullable<OpenClawConfig["models"]>["providers"];
    utilityProvider?: string;
    utilityModelId?: string;
    metadataSnapshot?: typeof metadataSnapshot;
    expected?: string;
  };
  it.each<Scenario>([
    { name: "model-level CLI pin", expected: "claude-cli" },
    { name: "explicit same-provider selection", utilityModelId: "claude-sonnet-5" },
    {
      name: "provider without automatic default",
      metadataSnapshot: snapshotWithDefaults({ openai: "gpt-5.4-mini" }),
    },
    { name: "explicit utility setting", defaults: { utilityModel: "openai/gpt-5.6-luna" } },
    { name: "disabled utility setting", defaults: { utilityModel: "" } },
    { name: "different provider", utilityProvider: "openai", utilityModelId: "gpt-5.6-luna" },
    { name: "default primary runtime", defaults: { models: {} } },
    {
      name: "provider-level runtime",
      defaults: { models: {} },
      providers: { anthropic: { baseUrl: "https://api.anthropic.com", models: [], ...cliEntry } },
    },
    { name: "wildcard runtime", defaults: { models: { "anthropic/*": cliEntry } } },
    {
      name: "derived HTTP pin",
      defaults: {
        models: { [primary]: cliEntry, [utility]: { agentRuntime: { id: "openclaw" } } },
      },
    },
    {
      name: "bare derived entry",
      defaults: { models: { [primary]: cliEntry, [utility]: {} } },
      expected: "claude-cli",
    },
    {
      name: "derived default alias",
      defaults: { models: { [primary]: cliEntry, [utility]: { agentRuntime: { id: "default" } } } },
      expected: "claude-cli",
    },
  ])(
    "inherits only an automatic model's eligible runtime: $name",
    ({ defaults, providers, expected, ...scenario }) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: primary, models: { [primary]: cliEntry }, ...defaults } },
        ...(providers ? { models: { providers } } : {}),
      };
      expect(
        resolveAutomaticUtilityRuntimeOverride({
          cfg,
          agentId: "main",
          utilityProvider: "anthropic",
          utilityModelId: "claude-haiku-4-5",
          metadataSnapshot,
          ...scenario,
        }),
      ).toBe(expected);
    },
  );
});
