import type {
  ModelCatalogProvider,
  ModelInferenceCapabilities,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { describe, expect, it } from "vitest";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
  const owner = {
    id: "owner",
    providers: metadata.modelCatalog?.aliases ? [provider.toLowerCase()] : undefined,
    ...metadata,
    modelCatalog: { ...metadata.modelCatalog, providers: { [provider]: definition } },
  };
  return { plugins: [owner] };
}
const emptyPlan = { entries: [], rows: [], conflicts: [] };

describe("manifest model catalog planner", () => {
  it("overlays rows without mutating inputs or replacing trusted transport and family", () => {
    const baseUrl = "https://api.anthropic.com";
    const modelUrl = "https://model.api.anthropic.com";
    const headers = { "X-Trusted": "yes" };
    const remote = { models: [{ id: "old", name: "Remote" }, { id: "new" }] };
    const models = [{ id: "old", name: "Bundled", baseUrl: modelUrl, headers }, { id: "kept" }];
    models.forEach(Object.freeze);
    Object.freeze(models);
    const registry = catalog("anthropic", {
      api: "anthropic-messages",
      family: "anthropic",
      baseUrl,
      models,
    });
    const plan = (resolveRemoteProvider: Parameters<typeof planRows>[0]["resolveRemoteProvider"]) =>
      planRows({ registry, resolveRemoteProvider });
    expect(
      plan(() => remote).rows.map((row) => [
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
    expect(plan(undefined).rows.map((row) => [row.id, row.api])).toEqual([
      ["kept", "anthropic-messages"],
      ["old", "anthropic-messages"],
    ]);
  });

  it("fills thinking and compat facts a hosted row omits from the bundled row", () => {
    const rows = planRows({
      registry: catalog("host", {
        models: [
          {
            id: "new-fact",
            thinkingLevelMap: { off: null },
            compat: { supportedReasoningEfforts: ["max"], maxTokensField: "max_tokens" },
          },
          { id: "hosted-wins", thinkingLevelMap: { off: null }, compat: { codeMode: "capable" } },
        ],
      }),
      resolveRemoteProvider: () => ({
        models: [
          { id: "new-fact", compat: { maxTokensField: "max_completion_tokens" } },
          {
            id: "hosted-wins",
            thinkingLevelMap: { high: "high" },
            compat: { codeMode: "preferred" },
          },
        ],
      }),
    }).rows;
    expect(rows.map(({ id, thinkingLevelMap, compat }) => [id, thinkingLevelMap, compat])).toEqual([
      ["hosted-wins", { high: "high" }, expect.objectContaining({ codeMode: "preferred" })],
      [
        "new-fact",
        { off: null },
        expect.objectContaining({
          supportedReasoningEfforts: ["max"],
          maxTokensField: "max_completion_tokens",
        }),
      ],
    ]);
  });

  it("keeps the bundled map of a row that owns its profile over an older hosted map", () => {
    const rows = planRows({
      registry: catalog("host", {
        models: [
          {
            id: "owned",
            thinkingLevelMap: { low: null, high: null, max: "max" },
            compat: { defaultThinkingLevel: "max" },
          },
        ],
      }),
      resolveRemoteProvider: () => ({
        models: [{ id: "owned", thinkingLevelMap: { low: "low", high: "high", max: "max" } }],
      }),
    }).rows;
    expect(rows[0]?.thinkingLevelMap).toEqual({ low: null, high: null, max: "max" });
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
    const resolveRemoteProvider = (provider: string) =>
      provider === "moonshot"
        ? { models: [{ id: model.id, name: "Remote" }, { id: "unrelated" }] }
        : undefined;
    const plan = planRows({ ...params, resolveRemoteProvider });
    expect(plan.entries).toMatchObject([{ provider: "moonshotai", discovery: "static" }]);
    expect(plan.rows).toMatchObject([
      {
        ...alias,
        provider: "moonshotai",
        id: model.id,
        ref: "moonshotai/kimi-k2.6",
        mergeKey: "moonshotai::kimi-k2.6",
        name: "Remote",
        source: "runtime-refresh",
      },
    ]);
    expect(planRows({ ...params, providerFilters: [] })).toStrictEqual(emptyPlan);
    expect(planRows({ ...params, mergeKeyFilter: new Set() })).toStrictEqual(emptyPlan);
  });

  function discovery(
    provider: string,
    kind: "static" | "runtime",
    models: ModelCatalogProvider["models"],
  ) {
    const modelCatalog = { discovery: { [provider]: kind } };
    return catalog(provider, { models }, { id: `${kind}-owner`, modelCatalog }).plugins;
  }
  it("selects static rows at their owning catalog boundary", () => {
    const registry = {
      plugins: (["static", "runtime"] as const).flatMap((kind) =>
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
          hosts: ["host.example"],
          hostSuffixes: ["region.example"],
        },
        { endpointClass: "future-endpoint", baseUrls: ["EXACT.example/v1/?ignored=1#fragment"] },
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
    "http://host.example:8080/compatible",
    "https://us.region.example/v1",
    "MODEL.example/v1/?ignored=1#fragment",
    "https://exact.example/v1",
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
      modelDefinition("authored", { baseUrl: "https://proxy.example/v1" }),
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
});
