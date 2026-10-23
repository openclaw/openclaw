import type {
  ModelCatalogProvider,
  ModelInferenceCapabilities,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isProviderCatalogSourceAllowed } from "../plugins/provider-config-owner.js";
import { planEffectiveModelCatalogRows } from "./index.js";
import {
  planManifestModelCatalogRows as planRows,
  planManifestModelCatalogSuppressions,
} from "./manifest-planner.js";

type Registry = Parameters<typeof planRows>[0]["registry"];
type Plugin = Registry["plugins"][number];
function catalog(
  provider: string,
  definition: ModelCatalogProvider,
  metadata: Partial<Plugin> = {},
): Registry {
  return {
    plugins: [
      {
        id: "owner",
        providers: metadata.modelCatalog?.aliases ? [provider.toLowerCase()] : undefined,
        ...metadata,
        modelCatalog: { ...metadata.modelCatalog, providers: { [provider]: definition } },
      },
    ],
  };
}
function expectedRow(provider: string, id: string) {
  return {
    provider,
    id,
    ref: `${provider}/${id}`,
    mergeKey: `${provider}::${id}`,
    name: id,
    source: "manifest",
    input: ["text"],
    reasoning: false,
    status: "available",
  };
}
const emptyPlan = { entries: [], rows: [], conflicts: [] };

describe("manifest model catalog planner", () => {
  it("overlays only declared providers and keeps remote transport fields inert", () => {
    const baseUrl = "https://api.anthropic.com";
    const modelUrl = "https://model.api.anthropic.com";
    const headers = { "X-Trusted": "yes" };
    const remote: Record<string, ModelCatalogProvider> = {
      anthropic: {
        api: "anthropic-messages",
        models: [{ id: "old", name: "Remote" }, { id: "new" }],
      },
      undeclared: { models: [{ id: "ignored" }] },
    };
    const registry = catalog(
      "anthropic",
      {
        api: "anthropic-messages",
        baseUrl,
        models: [{ id: "old", name: "Bundled", baseUrl: modelUrl, headers }, { id: "kept" }],
      },
      {
        modelCatalog: {
          aliases: { "anthropic-alias": { provider: "anthropic", api: "anthropic-messages" } },
        },
      },
    );
    const plan = (resolveRemoteProvider: Parameters<typeof planRows>[0]["resolveRemoteProvider"]) =>
      planRows({ registry, resolveRemoteProvider });
    expect(
      plan((provider) => remote[provider]).rows.map((row) => [
        row.id,
        row.name,
        row.source,
        row.baseUrl,
        row.headers,
      ]),
    ).toEqual([
      ["kept", "kept", "manifest", baseUrl, undefined],
      ["new", "new", "runtime-refresh", baseUrl, undefined],
      ["old", "Remote", "runtime-refresh", modelUrl, headers],
    ]);
    expect(
      plan(() => ({ api: "openai-completions", models: [] })).rows.map((row) => [
        row.id,
        row.source,
        row.api,
        row.baseUrl,
      ]),
    ).toEqual([
      ["kept", "manifest", "openai-completions", baseUrl],
      ["old", "manifest", "openai-completions", modelUrl],
    ]);
    expect(plan(() => undefined).rows.map((row) => row.api)).toEqual([
      "anthropic-messages",
      "anthropic-messages",
    ]);
  });

  describe("route-bound inference metadata", () => {
    const baseUrl = "https://fixture.invalid/v1";
    const inference = {
      chat: false,
      decision: {
        protocol: "fixture-decision",
        input: ["text"],
        questions: { choice: { probabilities: "categorical", abstention: false } },
        limits: { maxQuestions: 100 },
        billing: { unit: "requests", source: "provider-docs" },
      },
    } satisfies ModelInferenceCapabilities;
    const registry = catalog(
      "fixture",
      { api: "openai-responses", baseUrl, models: [{ id: "typed", baseUrl, inference }] },
      {
        modelCatalog: {
          aliases: {
            same: { provider: "fixture", baseUrl: `${baseUrl}/` },
            endpoint: { provider: "fixture", baseUrl: "https://routed.invalid/v1" },
            protocol: { provider: "fixture", api: "openai-completions" },
          },
        },
      },
    );
    const plan = (remote: ModelCatalogProvider) =>
      planRows({ registry, resolveRemoteProvider: () => remote }).rows;
    it.each([
      { provider: "same", expected: inference },
      { provider: "endpoint", expected: { chat: false } },
      { provider: "protocol", expected: { chat: false } },
    ])("binds alias facts to the effective route: $provider", ({ provider, expected }) => {
      expect(
        planRows({ registry, providerFilter: provider }).rows.map((row) => row.inference),
      ).toEqual([expected]);
    });
    it("retains matching hosted facts when a remote row replaces its label", () => {
      expect(plan({ models: [{ id: "typed", name: "Refreshed" }] })).toMatchObject([
        { name: "Refreshed", source: "runtime-refresh", inference },
      ]);
    });
    it.each([{ models: [] }, { models: [{ id: "typed", name: "Refreshed" }] }])(
      "clears facts when remote provider defaults change the effective API: %j",
      ({ models }) => {
        expect(plan({ api: "openai-completions", models })).toMatchObject([
          { api: "openai-completions", inference: { chat: false } },
        ]);
      },
    );
    it.each([
      { baseUrl: "https://remote.invalid/v1", models: [{ id: "typed", inference }] },
      { models: [{ id: "typed", baseUrl: "https://remote.invalid/v1", inference }] },
    ])("does not attach remote declarations to a retained trusted endpoint: %j", (remote) => {
      expect(plan(remote)).toMatchObject([{ baseUrl, inference: { chat: false } }]);
    });
    it("replaces a hosted contract as a whole when remote metadata supplies one", () => {
      expect(plan({ models: [{ id: "typed", inference: { chat: true } }] })[0]?.inference).toEqual({
        chat: true,
      });
    });
  });

  it("scopes requested merge keys while preserving alias overlays", () => {
    const remote = [
      { id: "requested", name: "Remote" },
      { id: "unrelated", name: "Remote unrelated" },
    ];
    const resolveRemoteProvider = vi.fn((provider: string) =>
      provider === "anthropic" ? { models: remote } : undefined,
    );
    const alias = {
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://alias.anthropic.test",
    } as const;
    const registry = {
      plugins: [
        ...catalog(
          "anthropic",
          { models: [{ id: "requested", name: "Bundled" }, { id: "unrelated" }] },
          { modelCatalog: { aliases: { "anthropic-alias": alias } } },
        ).plugins,
        ...catalog("unrelated", { models: [{ id: "unrelated" }] }).plugins,
      ],
    };
    const params = {
      registry,
      providerFilters: ["anthropic-alias"],
      mergeKeyFilter: new Set(["anthropic-alias::requested"]),
      resolveRemoteProvider,
    };
    const plan = planRows(params);
    expect(resolveRemoteProvider.mock.calls).toEqual([["anthropic"]]);
    expect(plan.entries).toHaveLength(1);
    expect(plan.rows).toMatchObject([
      {
        ...alias,
        provider: "anthropic-alias",
        id: "requested",
        name: "Remote",
        source: "runtime-refresh",
      },
    ]);
    resolveRemoteProvider.mockClear();
    expect(planRows({ ...params, providerFilters: [] })).toStrictEqual(emptyPlan);
    expect(resolveRemoteProvider.mock.calls).toEqual([]);
    expect(planRows({ ...params, mergeKeyFilter: new Set() })).toStrictEqual(emptyPlan);
    expect(resolveRemoteProvider.mock.calls).toEqual([["anthropic"]]);
  });

  it("selects static rows at their owning catalog boundary", () => {
    const registry = {
      plugins: (["static", "refreshable", "runtime"] as const).flatMap(
        (kind) =>
          catalog(
            `${kind}-provider`,
            { models: [{ id: "known" }] },
            {
              modelCatalog: { discovery: { [`${kind}-provider`]: kind } },
            },
          ).plugins,
      ),
    };
    const refs = (selection?: "static") =>
      planRows({
        registry,
        selection,
        resolveRemoteProvider: () => ({ models: [{ id: "refreshed" }] }),
      }).rows.map((row) => row.ref);
    expect(refs()).toEqual([
      "refreshable-provider/known",
      "refreshable-provider/refreshed",
      "runtime-provider/known",
      "runtime-provider/refreshed",
      "static-provider/known",
      "static-provider/refreshed",
    ]);
    expect(refs("static")).toEqual(["static-provider/known", "static-provider/refreshed"]);
  });

  it("keeps conflicting model rows excluded from every catalog selection", () => {
    const registry = {
      plugins: (["static", "runtime"] as const).flatMap(
        (kind) =>
          catalog(
            "shared",
            {
              models:
                kind === "static"
                  ? [{ id: "conflicted" }, { id: "kept", name: "Kept" }]
                  : [{ id: "CONFLICTED" }],
            },
            { id: `${kind}-owner`, modelCatalog: { discovery: { shared: kind } } },
          ).plugins,
      ),
    };
    for (const selection of [undefined, "static"] as const) {
      const plan = planRows({ registry, selection });
      expect(plan.entries).toHaveLength(2);
      expect(plan.rows, selection).toEqual([{ ...expectedRow("shared", "kept"), name: "Kept" }]);
      expect(plan.conflicts, selection).toEqual([{ provider: "shared", modelId: "conflicted" }]);
    }
  });

  // Regression for #73876: an OpenRouter org slug must resolve to the direct provider.
  it("plans moonshotai alias rows from the moonshot provider catalog", () => {
    const baseUrl = "https://api.moonshot.ai/v1";
    const api = "openai-completions";
    const model = {
      id: "kimi-k2.6",
      name: "Kimi K2.6",
      input: ["text", "image"],
      contextWindow: 256000,
    } satisfies ModelCatalogProvider["models"][number];
    const registry = catalog(
      "Moonshot",
      { api, baseUrl, models: [model] },
      {
        modelCatalog: {
          aliases: {
            moonshotai: { provider: "moonshot" },
            "moonshot-ai": { provider: "moonshot" },
          },
          discovery: { moonshot: "static" },
        },
      },
    );
    const rows = [
      {
        ...expectedRow("moonshotai", "kimi-k2.6"),
        name: "Kimi K2.6",
        input: ["text", "image"],
        contextWindow: 256000,
        api,
        baseUrl,
      },
    ];
    expect(planRows({ registry, providerFilter: "moonshotai" })).toEqual({
      entries: [{ provider: "moonshotai", discovery: "static", rows }],
      rows,
      conflicts: [],
    });
  });

  it("sorts fresh normalized rows without mutating frozen manifest inputs", () => {
    const models = [{ id: "z" }, { id: "a" }];
    models.forEach(Object.freeze);
    Object.freeze(models);
    const registry = catalog("fixture", { models });
    const plan = planRows({ registry });
    const repeated = planRows({ registry });
    const rows = ["a", "z"].map((id) => expectedRow("fixture", id));
    expect(plan).toStrictEqual({
      entries: [{ provider: "fixture", discovery: undefined, rows }],
      rows,
      conflicts: [],
    });
    expect(models).toStrictEqual([{ id: "z" }, { id: "a" }]);
    expect(repeated).toStrictEqual(plan);
    expect(repeated.rows).not.toBe(plan.rows);
    expect(repeated.rows[0]).not.toBe(plan.rows[0]);
    expect(plan.rows[0]).not.toBe(models[1]);
    expect(plan.entries[0]?.rows[0]).toBe(plan.rows[0]);
  });

  it("resolves raw overlay IDs before reporting normalized ID conflicts", () => {
    const plan = planRows({
      registry: catalog("fixture", { models: [{ id: " a ", name: "Local" }] }),
      resolveRemoteProvider: () => ({ models: [{ id: "a", name: "Remote" }] }),
    });
    expect(plan.entries[0]?.rows.map((row) => [row.id, row.name, row.source])).toEqual([
      ["a", "Local", "manifest"],
      ["a", "Remote", "runtime-refresh"],
    ]);
    expect(plan.rows).toEqual([]);
    expect(plan.conflicts).toStrictEqual([{ provider: "fixture", modelId: "a" }]);
  });

  it("plans suppressions for owned providers and declared provider aliases", () => {
    const model = "gpt-5.3-codex-spark";
    const reason = "Use openai/gpt-5.5.";
    const when = { baseUrlHosts: ["api.openai.com"] };
    const registry = catalog(
      "openai",
      { models: [] },
      {
        id: "openai",
        providers: ["openai", "openai"],
        modelCatalog: {
          aliases: { "azure-openai-responses": { provider: "openai" } },
          suppressions: [
            { provider: "openai", model, reason, when },
            { provider: "azure-openai-responses", model: "GPT-5.3-Codex-Spark", reason },
            { provider: "openrouter", model: "foreign-row" },
          ],
        },
      },
    );
    const common = { pluginId: "openai", model, reason };
    expect(planManifestModelCatalogSuppressions({ registry }).suppressions).toEqual([
      {
        ...common,
        provider: "azure-openai-responses",
        mergeKey: `azure-openai-responses::${model}`,
      },
      { ...common, provider: "openai", mergeKey: `openai::${model}`, when },
    ]);
  });
});

describe("provider endpoint catalog eligibility", () => {
  const registry = catalog(
    "fixture",
    {
      baseUrl: "https://native.example/v1",
      api: "openai-completions",
      models: [{ id: "native-model", name: "Native model", baseUrl: "https://model.example/v1" }],
    },
    {
      providerEndpoints: [
        {
          endpointClass: "openai-public",
          hosts: ["native.example"],
          hostSuffixes: ["region.example"],
        },
      ],
      modelCatalog: {
        aliases: { alternate: { provider: "fixture", baseUrl: "https://alternate.example/api" } },
      },
    },
  );
  const config = (baseUrl: string): OpenClawConfig => ({
    models: { providers: { fixture: { baseUrl, models: [] } } },
  });
  const plan = (
    baseUrl: string,
    overrides: Partial<Parameters<typeof planEffectiveModelCatalogRows>[0]> = {},
  ) => planEffectiveModelCatalogRows({ registry, config: config(baseUrl), ...overrides });
  it.each([
    "https://native.example/v1",
    "http://native.example:8080/compatible",
    "https://us.region.example/v1",
    "MODEL.example/v1/?ignored=1#fragment",
  ])("keeps native catalog rows at the declared endpoint %s", (baseUrl) => {
    expect(plan(baseUrl).rows.map((row) => row.id)).toEqual(["native-model"]);
  });
  it("excludes native manifest rows for a custom provider endpoint", () => {
    expect(plan("https://proxy.example/v1")).toMatchObject({ rows: [], entries: [] });
  });
  it("keeps the alias's declared endpoint independent of the target override", () => {
    const providers = {
      ...config("https://proxy.example/v1").models?.providers,
      alternate: { baseUrl: "https://alternate.example/api", models: [] },
    };
    expect(
      plan("https://proxy.example/v1", {
        config: { models: { providers } },
        providerFilter: "alternate",
      }).rows.map((row) => row.ref),
    ).toEqual(["alternate/native-model"]);
  });
  it("allows model-level overrides without a provider-level veto", () => {
    const authoredConfig: OpenClawConfig = {
      models: {
        providers: {
          fixture: {
            baseUrl: "",
            models: [
              {
                id: "authored",
                name: "Authored",
                baseUrl: "https://proxy.example/v1",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    };
    expect(
      planEffectiveModelCatalogRows({ registry, config: authoredConfig }).rows.map((row) => row.id),
    ).toEqual(["native-model"]);
  });

  it("keeps adapters with no native endpoint declaration eligible", () => {
    expect(
      plan("https://proxy.example/v1", {
        registry: catalog("fixture", { models: [{ id: "adapter-model", name: "Adapter model" }] }),
      }).rows.map((row) => row.id),
    ).toEqual(["adapter-model"]);
  });
  it.each([
    ["openai-public", "https://NATIVE.example/v1/"],
    ["openai-public", "native.example/v1?ignored=1#fragment"],
    ["future-endpoint", "https://NATIVE.example/v1/?ignored=1#fragment"],
  ])("normalizes endpoint-only declarations for %s at %s", (endpointClass, baseUrl) => {
    expect(
      isProviderCatalogSourceAllowed({
        provider: "fixture",
        config: config("https://native.example/v1"),
        plugin: { providerEndpoints: [{ endpointClass, baseUrls: [baseUrl] }] },
      }),
    ).toBe(true);
  });
});
