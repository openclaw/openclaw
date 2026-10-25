import type {
  ModelCatalogProvider,
  ModelInferenceCapabilities,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
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
    const registry = catalog("anthropic", {
      api: "anthropic-messages",
      family: "anthropic",
      baseUrl,
      models: [{ id: "old", name: "Bundled", baseUrl: modelUrl, headers }, { id: "kept" }],
    });
    const plan = (resolveRemoteProvider: Parameters<typeof planRows>[0]["resolveRemoteProvider"]) =>
      planRows({ registry, resolveRemoteProvider });
    expect(
      plan((provider) => remote[provider]).rows.map((row) => [
        row.id,
        row.name,
        row.source,
        row.baseUrl,
        row.headers,
        row.family,
      ]),
    ).toEqual([
      ["kept", "kept", "manifest", baseUrl, undefined, "anthropic"],
      ["new", "new", "runtime-refresh", baseUrl, undefined, "anthropic"],
      ["old", "Remote", "runtime-refresh", modelUrl, headers, "anthropic"],
    ]);
  });

  it("keeps bundled families under a hosted overlay, which cannot declare one", () => {
    const rows = planRows({
      registry: catalog("host", { models: [{ id: "listed", family: "openai" }, { id: "kept" }] }),
      resolveRemoteProvider: () => ({ models: [{ id: "listed" }, { id: "new" }] }),
    }).rows;
    expect(rows.map(({ id, source, family }) => [id, source, family])).toEqual([
      ["kept", "manifest", undefined],
      ["listed", "runtime-refresh", "openai"],
      ["new", "runtime-refresh", undefined],
    ]);
  });

  describe("route-bound inference metadata", () => {
    const baseUrl = "https://fixture.invalid/v1";
    const inference = {
      chat: false,
      decision: {
        protocol: "fixture-decision",
        input: ["text"],
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
    const typed = { id: "typed", inference };
    const inert = { chat: false };
    const changedApi = { api: "openai-completions" } as const;
    const foreign = "https://remote.invalid/v1";
    const refreshed = { name: "Refreshed", source: "runtime-refresh" };
    const remote = (
      models: ModelCatalogProvider["models"],
      defaults: Partial<ModelCatalogProvider> = {},
    ) => ({ ...defaults, models });
    it.each([
      [remote([{ id: "typed", name: "Refreshed" }]), inference, refreshed],
      [remote([], changedApi), inert, changedApi],
      [remote([{ id: "typed" }], changedApi), inert, changedApi],
      [remote([typed], { baseUrl: foreign }), inert, { baseUrl }],
      [remote([{ ...typed, baseUrl: foreign }]), inert, { baseUrl }],
      [remote([{ id: "typed", inference: { chat: true } }]), { chat: true }, undefined],
    ] satisfies Array<[ModelCatalogProvider, ModelInferenceCapabilities, object | undefined]>)(
      "binds refreshed inference to its effective route: %j",
      (downloaded, expected, fields) => {
        const rows = plan(downloaded);
        expect(rows.map((row) => row.inference)).toEqual([expected]);
        if (fields) {
          expect(rows[0]).toMatchObject(fields);
        }
      },
    );
  });

  // #73876: OpenRouter's org slug must resolve to the direct provider.
  it("normalizes Moonshot aliases and scopes requested merge keys through refreshes", () => {
    const model = { id: "kimi-k2.6" };
    const alias = {
      provider: "moonshot",
      api: "openai-completions",
      baseUrl: "https://api.moonshot.ai/v1",
    } as const;
    const registry = {
      plugins: [
        ...catalog(
          "Moonshot",
          { models: [model, { id: "unrelated" }] },
          { modelCatalog: { aliases: { moonshotai: alias }, discovery: { moonshot: "static" } } },
        ).plugins,
        ...catalog("unrelated", { models: [{ id: "unrelated" }] }).plugins,
      ],
    };
    const params = {
      registry,
      providerFilters: ["moonshotai"],
      mergeKeyFilter: new Set(["moonshotai::kimi-k2.6"]),
    };
    const native = planRows(params);
    expect(native.rows).toMatchObject([
      {
        ...model,
        ...alias,
        provider: "moonshotai",
        ref: "moonshotai/kimi-k2.6",
        mergeKey: "moonshotai::kimi-k2.6",
        source: "manifest",
      },
    ]);
    expect(native.entries).toMatchObject([{ provider: "moonshotai", discovery: "static" }]);
    const resolveRemoteProvider = (provider: string) =>
      provider === "moonshot"
        ? { models: [{ id: model.id, name: "Remote" }, { id: "unrelated" }] }
        : undefined;
    const plan = planRows({ ...params, resolveRemoteProvider });
    expect(plan.entries).toHaveLength(1);
    expect(plan.rows).toMatchObject([
      {
        ...alias,
        provider: "moonshotai",
        id: model.id,
        name: "Remote",
        source: "runtime-refresh",
      },
    ]);
    expect(planRows({ ...params, providerFilters: [] })).toStrictEqual(emptyPlan);
    expect(planRows({ ...params, mergeKeyFilter: new Set() })).toStrictEqual(emptyPlan);
  });

  function discovery(
    provider: string,
    kind: "static" | "runtime" | "refreshable",
    models: ModelCatalogProvider["models"],
  ) {
    return catalog(
      provider,
      { models },
      {
        id: `${kind}-owner`,
        modelCatalog: { discovery: { [provider]: kind } },
      },
    ).plugins;
  }
  it("selects static rows at their owning catalog boundary", () => {
    const registry = {
      plugins: (["static", "refreshable", "runtime"] as const).flatMap((kind) =>
        discovery(kind, kind, [{ id: "known" }]),
      ),
    };
    const refs = (selection?: "static") =>
      planRows({
        registry,
        selection,
        resolveRemoteProvider: () => ({ models: [{ id: "refreshed" }] }),
      }).rows.map((row) => row.ref);
    expect(refs()).toEqual([
      "refreshable/known",
      "refreshable/refreshed",
      "runtime/known",
      "runtime/refreshed",
      "static/known",
      "static/refreshed",
    ]);
    expect(refs("static")).toEqual(["static/known", "static/refreshed"]);
  });

  it("keeps conflicting model rows excluded from every catalog selection", () => {
    const registry = {
      plugins: [
        ...discovery("shared", "static", [{ id: "conflicted" }, { id: "kept", name: "Kept" }]),
        ...discovery("shared", "runtime", [{ id: "CONFLICTED" }]),
      ],
    };
    for (const selection of [undefined, "static"] as const) {
      const plan = planRows({ registry, selection });
      expect(plan.entries).toHaveLength(2);
      expect(
        plan.rows.map(({ ref, name }) => [ref, name]),
        selection,
      ).toEqual([["shared/kept", "Kept"]]);
      expect(plan.conflicts, selection).toEqual([{ provider: "shared", modelId: "conflicted" }]);
    }
  });

  it("sorts fresh normalized rows without mutating frozen manifest inputs", () => {
    const models = [{ id: "z" }, { id: "a" }];
    models.forEach(Object.freeze);
    Object.freeze(models);
    const api = "anthropic-messages";
    const registry = catalog("fixture", { api, models });
    const plan = planRows({ registry });
    expect(plan.rows.map((row) => [row.ref, row.api])).toEqual([
      ["fixture/a", api],
      ["fixture/z", api],
    ]);
    expect(models).toStrictEqual([{ id: "z" }, { id: "a" }]);
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
    const model = "retired";
    const reason = "Use the replacement.";
    const when = { baseUrlHosts: ["api.openai.com"] };
    const registry = catalog(
      "openai",
      { models: [] },
      {
        id: "openai",
        providers: ["openai", "openai"],
        modelCatalog: {
          aliases: { alias: { provider: "openai" } },
          suppressions: [
            { provider: "openai", model, reason, when },
            { provider: "alias", model: "RETIRED", reason },
            { provider: "openrouter", model: "foreign-row" },
          ],
        },
      },
    );
    const common = { pluginId: "openai", model, reason };
    expect(planManifestModelCatalogSuppressions({ registry }).suppressions).toEqual([
      {
        ...common,
        provider: "alias",
        mergeKey: `alias::${model}`,
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
  const config = (baseUrl: string, models: ModelDefinitionConfig[] = []): OpenClawConfig => ({
    models: { providers: { fixture: { baseUrl, models } } },
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
    const authoredConfig = config("", [
      {
        id: "authored",
        name: "Authored",
        baseUrl: "https://proxy.example/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        maxTokens: 4096,
      },
    ]);
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
