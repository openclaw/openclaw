import { describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../config/types.js";
import { buildCatalogModel as makeModel } from "../plugin-sdk/provider-catalog.test-support.js";
import type { ProviderCatalogOutcome } from "./provider-catalog.types.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  runProviderCatalog,
  runProviderStaticCatalog,
} from "./provider-discovery.js";
import type { ProviderCatalogOrder, ProviderPlugin } from "./types.js";

function makeProvider({
  id,
  label = id,
  order,
  ...aliases
}: {
  id: string;
  label?: string;
  order?: ProviderCatalogOrder;
  aliases?: string[];
  hookAliases?: string[];
}): ProviderPlugin {
  return {
    id,
    label,
    auth: [],
    ...aliases,
    catalog: { order, run: async () => null },
  };
}

function makeModelProviderConfig(overrides?: Partial<ModelProviderConfig>): ModelProviderConfig {
  return {
    baseUrl: "http://127.0.0.1:8000/v1",
    models: [],
    ...overrides,
  };
}

function catalogProvider(run: NonNullable<ProviderPlugin["catalog"]>["run"], id = "openai") {
  return { ...makeProvider({ id }), catalog: { run } };
}

function runCatalog(
  provider: ProviderPlugin,
  options: Partial<Omit<Parameters<typeof runProviderCatalog>[0], "provider">> = {},
) {
  return runProviderCatalog({
    provider,
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    ...options,
  });
}

it("groups providers by declared order and sorts labels within each group", () => {
  const grouped = groupPluginDiscoveryProvidersByOrder([
    makeProvider({ id: "late-b", label: "Zulu" }),
    makeProvider({ id: "late-a", label: "Alpha" }),
    makeProvider({ id: "paired", label: "Paired", order: "paired" }),
    makeProvider({ id: "profile", label: "Profile", order: "profile" }),
    makeProvider({ id: "simple", label: "Simple", order: "simple" }),
  ]);
  expect(
    Object.fromEntries(
      Object.entries(grouped).map(([key, providers]) => [key, providers.map(({ id }) => id)]),
    ),
  ).toEqual({
    simple: ["simple"],
    profile: ["profile"],
    paired: ["paired"],
    late: ["late-a", "late-b"],
  });
});

describe("runProviderCatalog", () => {
  const outcomeCases: Array<{
    name: string;
    input: Array<ProviderCatalogOutcome & { apiKey?: string }>;
    expected: ProviderCatalogOutcome[];
    probeAuth?: boolean;
  }> = [
    {
      name: "redacts provider-owned diagnostics across an async hook",
      input: [
        {
          provider: "openai",
          profileId: "openai:chatgpt",
          rejectionScope: "catalog",
          status: "auth-rejected",
          apiKey: "synthetic-not-for-diagnostics",
        },
      ],
      expected: [
        {
          provider: "openai",
          profileId: "openai:chatgpt",
          rejectionScope: "catalog",
          status: "auth-rejected",
        },
      ],
    },
    {
      name: "copies only valid ready model order",
      input: [
        { provider: "openai", status: "ready", modelOrder: [" second ", "", "second", "first"] },
        {
          provider: "openai",
          profileId: "openai:stale",
          status: "unavailable",
          modelOrder: ["stale"],
        },
      ],
      expected: [
        { provider: "openai", status: "ready", modelOrder: ["second", "first"] },
        { provider: "openai", profileId: "openai:stale", status: "unavailable" },
      ],
    },
    {
      name: "preserves provider-owned profiles after multiple auth probes",
      probeAuth: true,
      input: [{ provider: "openai", profileId: "openai:profile-b", status: "ready" }],
      expected: [{ provider: "openai", profileId: "openai:profile-b", status: "ready" }],
    },
  ];
  it.each(outcomeCases)("$name", async ({ input, expected, probeAuth }) => {
    const outcomes: ProviderCatalogOutcome[] = [];
    let authCall = 0;
    await runCatalog(
      catalogProvider(async (ctx) => {
        await Promise.resolve();
        if (probeAuth) {
          ctx.resolveProviderAuth("openai");
          ctx.resolveProviderAuth("openai");
        }
        return { providers: {}, outcomes: input };
      }),
      {
        resolveProviderAuth: () => ({
          apiKey: `selected-key-${++authCall}`,
          mode: "api_key",
          profileId: `openai:profile-${authCall === 1 ? "a" : "b"}`,
          source: "profile",
        }),
        reportCatalogOutcome: (outcome) => outcomes.push(outcome),
      },
    );
    expect(outcomes).toEqual(expected);
  });

  it.each([
    { providerIds: ["OPENAI"], expected: ["openai"] },
    { providerIds: ["azure-openai"], expected: ["azure-openai"] },
    { providerIds: [], expected: [] },
  ])(
    "emits outcomes only for selected provider identities: $providerIds",
    async ({ providerIds, expected }) => {
      const outcomes: string[] = [];
      const provider = catalogProvider(async () => ({
        providers: {},
        outcomes: [
          { provider: "openai", profileId: "openai:private", status: "auth-rejected" },
          { provider: "azure-openai", profileId: "azure-openai:selected", status: "ready" },
          { provider: "unrelated", status: "unavailable" },
        ],
      }));
      await runCatalog(provider, {
        providerIds,
        reportCatalogOutcome: (outcome) => outcomes.push(outcome.provider),
      });

      expect(outcomes).toEqual(expected);
    },
  );
});

describe("normalizePluginDiscoveryResult", () => {
  const model = makeModel("kept-model");
  const config = makeModelProviderConfig({ models: [model], api: "openai-completions" });
  const ignored = makeModelProviderConfig({ baseUrl: "http://ignored" });
  it.each<{
    name: string;
    provider: ProviderPlugin;
    result: Parameters<typeof normalizePluginDiscoveryResult>[0]["result"];
    keys: string[];
  }>([
    {
      name: "maps a single provider result to aliases and hook aliases",
      provider: makeProvider({
        id: "Anthropic",
        aliases: ["anthropic-api"],
        hookAliases: ["claude-cli"],
      }),
      result: { provider: config },
      keys: ["anthropic", "anthropic-api", "claude-cli"],
    },
    {
      name: "normalizes keys for multi-provider discovery results",
      provider: makeProvider({ id: "ignored" }),
      result: { providers: { " VLLM ": config, "": ignored } },
      keys: ["vllm"],
    },
    {
      name: "drops dangerous normalized provider keys",
      provider: makeProvider({ id: "__proto__", aliases: ["constructor"], hookAliases: ["safe"] }),
      result: { provider: config },
      keys: ["safe"],
    },
    {
      name: "drops dangerous multi-provider discovery keys",
      provider: makeProvider({ id: "ignored" }),
      result: {
        providers: {
          ["__proto__"]: ignored,
          constructor: ignored,
          prototype: ignored,
          safe: config,
        },
      },
      keys: ["safe"],
    },
  ])("$name without copying admitted provider/model facts", ({ provider, result, keys }) => {
    const normalized = normalizePluginDiscoveryResult({ provider, result });
    expect(Object.getPrototypeOf(normalized)).toBe(null);
    expect(Object.keys(normalized)).toEqual(keys);
    for (const key of keys) {
      expect(normalized[key]).toBe(config);
      expect(normalized[key]?.models[0]).toBe(model);
    }
  });
});

describe("runProviderStaticCatalog", () => {
  it("runs static catalogs with a sterile context", async () => {
    const provider: ProviderPlugin = {
      id: "demo",
      label: "Demo",
      auth: [],
      staticCatalog: {
        run: async (ctx) => {
          expect(ctx).toEqual({
            config: {},
            env: {},
            resolveProviderApiKey: expect.any(Function),
            resolveProviderAuth: expect.any(Function),
          });
          expect(ctx.resolveProviderApiKey("demo")).toEqual({ apiKey: undefined });
          expect(ctx.resolveProviderAuth("demo")).toEqual({
            apiKey: undefined,
            mode: "none",
            source: "none",
          });
          expect(ctx).not.toHaveProperty("agentDir");
          expect(ctx).not.toHaveProperty("workspaceDir");
          return {
            provider: makeModelProviderConfig({ baseUrl: "https://static.example/v1" }),
          };
        },
      },
    };

    await expect(runProviderStaticCatalog({ provider })).resolves.toEqual({
      provider: {
        baseUrl: "https://static.example/v1",
        models: [],
      },
    });
  });
});
