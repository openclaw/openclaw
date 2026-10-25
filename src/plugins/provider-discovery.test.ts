import { describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../config/types.js";
import { buildCatalogModel as makeModel } from "../plugin-sdk/provider-catalog.test-support.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  runProviderCatalog,
  runProviderStaticCatalog,
} from "./provider-discovery.js";
import type { ProviderCatalogOrder, ProviderPlugin } from "./types.js";

function makeProvider(params: {
  id: string;
  label?: string;
  order?: ProviderCatalogOrder;
  aliases?: string[];
  hookAliases?: string[];
}): ProviderPlugin {
  const hook = {
    ...(params.order ? { order: params.order } : {}),
    run: async () => null,
  };
  return {
    id: params.id,
    label: params.label ?? params.id,
    auth: [],
    ...(params.aliases ? { aliases: params.aliases } : {}),
    ...(params.hookAliases ? { hookAliases: params.hookAliases } : {}),
    catalog: hook,
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

type NormalizePluginDiscoveryResultCase = {
  name: string;
  provider: ProviderPlugin;
  result: Parameters<typeof normalizePluginDiscoveryResult>[0]["result"];
  expected: Record<string, unknown>;
};

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
  it("passes the selected provider identities into the catalog hook", async () => {
    let providerIds: readonly string[] | undefined;
    const provider = catalogProvider(async (ctx) => {
      providerIds = ctx.providerIds;
      return null;
    });
    await runCatalog(provider, { providerIds: ["azure-openai"] });
    expect(providerIds).toEqual(["azure-openai"]);
  });

  it("carries explicit provider-owned catalog outcomes across an async hook", async () => {
    const outcomes: Array<{
      provider: string;
      profileId?: string;
      rejectionScope?: "catalog";
      status: "ready" | "auth-rejected" | "unavailable";
    }> = [];
    const provider = catalogProvider(async () => {
      await Promise.resolve();
      return {
        providers: {},
        outcomes: [
          {
            provider: "openai",
            profileId: "openai:chatgpt",
            rejectionScope: "catalog",
            status: "auth-rejected",
            apiKey: "synthetic-not-for-diagnostics",
          },
        ],
      };
    });
    await runCatalog(provider, {
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      reportCatalogOutcome: (outcome) => outcomes.push(outcome),
    });

    expect(outcomes).toEqual([
      {
        provider: "openai",
        profileId: "openai:chatgpt",
        rejectionScope: "catalog",
        status: "auth-rejected",
      },
    ]);
  });

  it("copies only valid ready model order through the catalog boundary", async () => {
    const outcomes: Array<{ status: string; modelOrder?: readonly string[] }> = [];
    const provider = catalogProvider(
      async () => ({
        providers: {},
        outcomes: [
          {
            provider: "demo",
            status: "ready",
            modelOrder: [" second ", "", "second", "first"],
          },
          {
            provider: "demo",
            profileId: "demo:stale",
            status: "unavailable",
            modelOrder: ["stale"],
          },
        ],
      }),
      "demo",
    );
    await runCatalog(provider, {
      reportCatalogOutcome: (outcome) => outcomes.push(outcome),
    });

    expect(outcomes).toEqual([
      { provider: "demo", status: "ready", modelOrder: ["second", "first"] },
      { provider: "demo", profileId: "demo:stale", status: "unavailable" },
    ]);
  });

  it("preserves provider-owned profile outcomes after multiple auth probes", async () => {
    const outcomes: Array<{ profileId?: string; status: string }> = [];
    const provider = catalogProvider(async (ctx) => {
      ctx.resolveProviderAuth("openai");
      ctx.resolveProviderAuth("openai");
      return {
        providers: {},
        outcomes: [
          {
            provider: "openai",
            profileId: "openai:profile-b",
            status: "ready",
          },
        ],
      };
    });
    let authCall = 0;

    await runCatalog(provider, {
      resolveProviderAuth: () => {
        authCall += 1;
        return {
          apiKey: `selected-key-${authCall}`,
          mode: "api_key",
          profileId: `openai:profile-${authCall === 1 ? "a" : "b"}`,
          source: "profile",
        };
      },
      reportCatalogOutcome: (outcome) => outcomes.push(outcome),
    });

    expect(outcomes).toEqual([
      { provider: "openai", profileId: "openai:profile-b", status: "ready" },
    ]);
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
  it("retains provider and model facts by reference", () => {
    const model = makeModel("kept-model");
    const config = makeModelProviderConfig({ models: [model] });
    const normalized = normalizePluginDiscoveryResult({
      provider: makeProvider({ id: "Demo", aliases: ["demo-alias"] }),
      result: { provider: config },
    });

    expect(normalized.demo).toBe(config);
    expect(normalized["demo-alias"]).toBe(config);
    expect(normalized.demo?.models[0]).toBe(model);
  });

  const expectedLocal = { baseUrl: "http://127.0.0.1:8000/v1", models: [] };
  const expectedSafe = { baseUrl: "http://safe.example/v1", models: [] };
  const expectedAnthropic = {
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: [],
  };
  const cases: NormalizePluginDiscoveryResultCase[] = [
    {
      name: "maps a single provider result to aliases and hook aliases",
      provider: makeProvider({
        id: "Anthropic",
        aliases: ["anthropic-api"],
        hookAliases: ["claude-cli"],
      }),
      result: {
        provider: makeModelProviderConfig({
          baseUrl: "https://api.anthropic.com",
          api: "anthropic-messages",
        }),
      },
      expected: {
        anthropic: expectedAnthropic,
        "anthropic-api": expectedAnthropic,
        "claude-cli": expectedAnthropic,
      },
    },
    {
      name: "normalizes keys for multi-provider discovery results",
      provider: makeProvider({ id: "ignored" }),
      result: {
        providers: {
          " VLLM ": makeModelProviderConfig(),
          "": makeModelProviderConfig({ baseUrl: "http://ignored" }),
        },
      },
      expected: { vllm: expectedLocal },
    },
    {
      name: "drops dangerous normalized provider keys",
      provider: makeProvider({ id: "__proto__", aliases: ["constructor"], hookAliases: ["safe"] }),
      result: {
        provider: makeModelProviderConfig({
          baseUrl: "http://safe.example/v1",
        }),
      },
      expected: { safe: expectedSafe },
    },
    {
      name: "drops dangerous multi-provider discovery keys",
      provider: makeProvider({ id: "ignored" }),
      result: {
        providers: {
          ["__proto__"]: makeModelProviderConfig({ baseUrl: "http://polluted.example/v1" }),
          constructor: makeModelProviderConfig({ baseUrl: "http://constructor.example/v1" }),
          prototype: makeModelProviderConfig({ baseUrl: "http://prototype.example/v1" }),
          safe: makeModelProviderConfig({ baseUrl: "http://safe.example/v1" }),
        },
      },
      expected: { safe: expectedSafe },
    },
  ];

  it.each(cases)("$name", ({ provider, result, expected }) => {
    const normalized = normalizePluginDiscoveryResult({ provider, result });
    expect(Object.getPrototypeOf(normalized)).toBe(null);
    expect(Object.fromEntries(Object.entries(normalized))).toEqual(expected);
  });
});

describe("runProviderStaticCatalog", () => {
  it("runs static catalogs with a sterile context", async () => {
    let calls = 0;
    const provider: ProviderPlugin = {
      id: "demo",
      label: "Demo",
      auth: [],
      staticCatalog: {
        run: async (ctx) => {
          calls += 1;
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

    expect(calls).toBe(1);
  });
});
