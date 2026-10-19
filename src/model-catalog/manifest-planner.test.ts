import type { ModelInferenceCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";
import { describe, expect, it, vi } from "vitest";
import {
  planManifestModelCatalogRows as planRows,
  planManifestModelCatalogSuppressions as planSuppressions,
} from "./manifest-planner.js";

type PlannerParams = Parameters<typeof planRows>[0];
type Catalog = NonNullable<PlannerParams["registry"]["plugins"][number]["modelCatalog"]>;
function pluginFor(id: string, modelCatalog: Catalog, providers = [id]) {
  return { id, providers, modelCatalog };
}
function registryFor(provider: string, modelCatalog: Catalog, providers = [provider]) {
  return { plugins: [pluginFor(provider, modelCatalog, providers)] };
}

describe("manifest model catalog planner", () => {
  it("overlays only declared providers and keeps remote transport fields inert", () => {
    const api = "anthropic-messages";
    const baseUrl = "https://api.anthropic.com";
    const modelUrl = "https://model.api.anthropic.com";
    const headers = { "X-Trusted": "yes" };
    const params: PlannerParams = {
      registry: registryFor("anthropic", {
        providers: {
          anthropic: {
            api,
            baseUrl,
            models: [{ id: "old", name: "Bundled", baseUrl: modelUrl, headers }, { id: "kept" }],
          },
        },
      }),
      remoteOverlay: {
        anthropic: {
          api,
          models: [{ id: "old", name: "Remote" }, { id: "new" }],
        },
        undeclared: { models: [{ id: "ignored" }] },
      },
    };
    const plan = planRows(params);
    expect(
      plan.rows.map((row) => [row.id, row.name, row.source, row.baseUrl, row.headers]),
    ).toEqual([
      ["kept", "kept", "manifest", baseUrl, undefined],
      ["new", "new", "runtime-refresh", baseUrl, undefined],
      ["old", "Remote", "runtime-refresh", modelUrl, headers],
    ]);
    const emptyOverlay = {
      anthropic: { api: "openai-completions", models: [] },
    } satisfies PlannerParams["remoteOverlay"];
    const emptyRemotePlan = planRows({ ...params, remoteOverlay: emptyOverlay });
    expect(emptyRemotePlan.rows.map((row) => [row.id, row.source, row.api, row.baseUrl])).toEqual([
      ["kept", "manifest", "openai-completions", baseUrl],
      ["old", "manifest", "openai-completions", modelUrl],
    ]);
    const absentRemotePlan = planRows({
      ...params,
      remoteOverlay: emptyOverlay,
      resolveRemoteProvider: () => undefined,
    });
    expect(absentRemotePlan.rows.map((row) => row.api)).toEqual([api, api]);
  });

  describe("route-bound inference metadata", () => {
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
    const registry = registryFor("fixture", {
      providers: {
        fixture: {
          api: "openai-responses" as const,
          baseUrl: "https://fixture.invalid/v1",
          models: [{ id: "typed", baseUrl: "https://fixture.invalid/v1", inference }],
        },
      },
      aliases: {
        same: { provider: "fixture", baseUrl: "https://fixture.invalid/v1/" },
        endpoint: { provider: "fixture", baseUrl: "https://routed.invalid/v1" },
        protocol: { provider: "fixture", api: "openai-completions" as const },
      },
    });

    it.each([
      { provider: "same", expected: inference },
      { provider: "endpoint", expected: { chat: false } },
      { provider: "protocol", expected: { chat: false } },
    ])("binds alias facts to the effective route: $provider", ({ provider, expected }) => {
      const plan = planRows({ registry, providerFilter: provider });
      expect(plan.rows).toHaveLength(1);
      expect(plan.rows[0]?.inference).toEqual(expected);
    });

    const remoteRows = (remote: Catalog["providers"][string]) =>
      planRows({ registry, remoteOverlay: { fixture: remote } }).rows;

    it("retains matching hosted facts when a remote row replaces its label", () => {
      expect(remoteRows({ models: [{ id: "typed", name: "Refreshed" }] })).toMatchObject([
        { name: "Refreshed", source: "runtime-refresh", inference },
      ]);
    });

    it.each([[], [{ id: "typed", name: "Refreshed" }]])(
      "clears facts when remote defaults change the API: %j",
      (models) => {
        expect(remoteRows({ api: "openai-completions", models })).toMatchObject([
          { api: "openai-completions", inference: { chat: false } },
        ]);
      },
    );

    it.each(["provider", "model"])("rejects an untrusted %s endpoint declaration", (level) => {
      const endpoint = { baseUrl: "https://remote.invalid/v1" };
      expect(
        remoteRows({
          ...(level === "provider" ? endpoint : {}),
          models: [{ id: "typed", inference, ...(level === "model" ? endpoint : {}) }],
        }),
      ).toMatchObject([{ baseUrl: "https://fixture.invalid/v1", inference: { chat: false } }]);
    });

    it("replaces a hosted contract as a whole when remote metadata supplies one", () => {
      expect(
        remoteRows({ models: [{ id: "typed", inference: { chat: true } }] })[0]?.inference,
      ).toEqual({ chat: true });
    });
  });

  it("scopes requested merge keys while preserving alias overlays", () => {
    const resolveRemoteProvider = vi.fn((provider: string) =>
      provider === "anthropic"
        ? {
            models: [
              { id: "requested", name: "Remote" },
              { id: "unrelated", name: "Remote unrelated" },
            ],
          }
        : undefined,
    );
    const params: Parameters<typeof planRows>[0] = {
      registry: {
        plugins: [
          pluginFor("anthropic", {
            aliases: {
              "anthropic-alias": {
                provider: "anthropic",
                api: "anthropic-messages",
                baseUrl: "https://alias.anthropic.test",
              },
            },
            providers: {
              anthropic: {
                models: [{ id: "requested", name: "Bundled" }, { id: "unrelated" }],
              },
            },
          }),
          pluginFor("unrelated", {
            providers: { unrelated: { models: [{ id: "unrelated" }] } },
          }),
        ],
      },
      providerFilters: ["anthropic-alias"],
      mergeKeyFilter: new Set(["anthropic-alias::requested"]),
      resolveRemoteProvider,
    };
    const plan = planRows(params);

    expect(resolveRemoteProvider.mock.calls).toEqual([["anthropic"]]);
    expect(plan.entries).toHaveLength(1);
    expect(plan.rows).toMatchObject([
      {
        provider: "anthropic-alias",
        id: "requested",
        name: "Remote",
        api: "anthropic-messages",
        baseUrl: "https://alias.anthropic.test",
        source: "runtime-refresh",
      },
    ]);
    resolveRemoteProvider.mockClear();
    const emptyPlan = { entries: [], rows: [], conflicts: [] };
    expect(planRows({ ...params, providerFilters: [] })).toStrictEqual(emptyPlan);
    expect(resolveRemoteProvider.mock.calls).toEqual([]);
    expect(planRows({ ...params, mergeKeyFilter: new Set() })).toStrictEqual(emptyPlan);
    expect(resolveRemoteProvider.mock.calls).toEqual([["anthropic"]]);
  });

  it("selects static and supplemental rows at their owning catalog boundary", () => {
    const providers = [
      ["static-provider", "static"],
      ["refreshable-provider", "refreshable"],
      ["runtime-provider", "runtime"],
    ] as const;
    const registry = {
      plugins: providers.map(([provider, discovery]) =>
        pluginFor(provider, {
          providers: { [provider]: { models: [{ id: "known" }] } },
          discovery: { [provider]: discovery },
        }),
      ),
    };
    const remoteOverlay = Object.fromEntries(
      providers.map(([provider]) => [provider, { models: [{ id: "refreshed" }] }]),
    );
    const refsFor = (selection?: PlannerParams["selection"]) =>
      planRows({
        registry,
        remoteOverlay,
        ...(selection ? { selection } : {}),
      }).rows.map((row) => row.ref);

    const pair = (provider: string) =>
      ["known", "refreshed"].map((id) => `${provider}-provider/${id}`);
    expect(refsFor()).toEqual([...pair("refreshable"), ...pair("runtime"), ...pair("static")]);
    expect(refsFor("static")).toEqual(pair("static"));
    expect(refsFor("supplemental")).toEqual([
      ...pair("refreshable"),
      "runtime-provider/refreshed",
      ...pair("static"),
    ]);
  });

  it("keeps conflicting model rows excluded from every catalog selection", () => {
    const registry = {
      plugins: [
        {
          id: "first-owner",
          modelCatalog: {
            providers: { shared: { models: [{ id: "conflicted" }] } },
            discovery: { shared: "static" as const },
          },
        },
        {
          id: "second-owner",
          modelCatalog: {
            providers: { shared: { models: [{ id: "conflicted" }] } },
            discovery: { shared: "runtime" as const },
          },
        },
      ],
    };

    for (const selection of [undefined, "static", "supplemental"] as const) {
      const plan = planManifestModelCatalogRows({
        registry,
        ...(selection ? { selection } : {}),
      });
      expect(plan.rows, selection).toEqual([]);
      expect(plan.conflicts, selection).toHaveLength(1);
    }
  });

  it("builds manifest rows from plugin-owned catalog providers", () => {
    const plan = planManifestModelCatalogRows({
      registry: {
        plugins: [
          {
            id: "moonshot",
            modelCatalog: {
              discovery: {
                moonshot: "static",
              },
              providers: {
                Moonshot: {
                  api: "openai-responses",
                  baseUrl: "https://api.moonshot.ai/v1",
                  models: [
                    {
                      id: "kimi-k2.6",
                      input: ["text", "image"],
                      contextWindow: 256000,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    });

    expect(plan.entries).toEqual([
      {
        pluginId: "moonshot",
        provider: "moonshot",
        discovery: "static",
        rows: [
          {
            provider: "moonshot",
            id: "kimi-k2.6",
            ref: "moonshot/kimi-k2.6",
            mergeKey: "moonshot::kimi-k2.6",
            name: "kimi-k2.6",
            source: "manifest",
            input: ["text", "image"],
            reasoning: false,
            status: "available",
            api: "openai-responses",
            baseUrl: "https://api.moonshot.ai/v1",
            contextWindow: 256000,
          },
        ],
      },
    ]);
    expect(plan.rows.map((row) => row.ref)).toEqual(["moonshot/kimi-k2.6"]);
    expect(plan.conflicts).toStrictEqual([]);
  });

  // Regression for #73876: an OpenRouter org slug must resolve to the direct provider.
  it("plans moonshotai alias rows from the moonshot provider catalog", () => {
    const plan = planRows({
      providerFilter: "moonshotai",
      registry: registryFor("moonshot", {
        aliases: {
          moonshotai: { provider: "moonshot" },
        },
        discovery: { moonshot: "static" },
        providers: {
          moonshot: {
            api: "openai-completions",
            baseUrl: "https://api.moonshot.ai/v1",
            models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }],
          },
        },
      }),
    });

    const row = {
      provider: "moonshotai",
      id: "kimi-k2.6",
      ref: "moonshotai/kimi-k2.6",
      mergeKey: "moonshotai::kimi-k2.6",
      name: "Kimi K2.6",
      source: "manifest",
      api: "openai-completions",
      baseUrl: "https://api.moonshot.ai/v1",
    };
    expect(plan).toMatchObject({
      entries: [{ pluginId: "moonshot", provider: "moonshotai", discovery: "static", rows: [row] }],
      rows: [row],
    });
  });

  it("sorts fresh normalized rows without mutating frozen manifest inputs", () => {
    const models = [{ id: "z" }, { id: "a" }];
    models.forEach(Object.freeze);
    Object.freeze(models);
    const registry = {
      plugins: [{ id: "owner", modelCatalog: { providers: { fixture: { models } } } }],
    };
    const plan = planManifestModelCatalogRows({ registry });
    const repeated = planManifestModelCatalogRows({ registry });
    const rows = ["a", "z"].map((id) => ({
      id,
      provider: "fixture",
      ref: `fixture/${id}`,
      mergeKey: `fixture::${id}`,
      name: id,
      source: "manifest",
      input: ["text"],
      reasoning: false,
      status: "available",
    }));
    expect(plan).toStrictEqual({
      entries: [{ pluginId: "owner", provider: "fixture", discovery: undefined, rows }],
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
      registry: registryFor(
        "owner",
        {
          providers: { fixture: { models: [{ id: " a ", name: "Local" }] } },
        },
        [],
      ),
      remoteOverlay: { fixture: { models: [{ id: "a", name: "Remote" }] } },
    });
    expect(plan.entries[0]?.rows.map((row) => [row.id, row.name, row.source])).toEqual([
      ["a", "Local", "manifest"],
      ["a", "Remote", "runtime-refresh"],
    ]);
    expect(plan.rows).toEqual([]);
    expect(plan.conflicts).toStrictEqual([
      {
        mergeKey: "fixture::a",
        ref: "fixture/a",
        provider: "fixture",
        modelId: "a",
        firstPluginId: "owner",
        secondPluginId: "owner",
      },
    ]);
  });

  it("reports duplicate provider/model keys and excludes conflicted rows", () => {
    const plan = planManifestModelCatalogRows({
      registry: {
        plugins: [
          {
            id: "z-first",
            modelCatalog: {
              providers: {
                openai: {
                  models: [
                    { id: "gpt-5.4", name: "First GPT-5.4" },
                    { id: "gpt-5.5", name: "GPT-5.5" },
                  ],
                },
              },
            },
          },
          {
            id: "a-second",
            modelCatalog: {
              providers: {
                openai: {
                  models: [{ id: "GPT-5.4", name: "Second GPT-5.4" }],
                },
              },
            },
          },
        ],
      },
    });

    expect(plan.entries).toHaveLength(2);
    expect(plan.conflicts).toEqual([
      {
        mergeKey: "openai::gpt-5.4",
        ref: "openai/gpt-5.4",
        provider: "openai",
        modelId: "gpt-5.4",
        firstPluginId: "z-first",
        secondPluginId: "a-second",
      },
    ]);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]?.mergeKey).toBe("openai::gpt-5.5");
    expect(plan.rows[0]?.name).toBe("GPT-5.5");
  });
});

it("plans suppressions for owned providers and declared provider aliases", () => {
  const model = "gpt-5.3-codex-spark";
  const reason = "Use openai/gpt-5.5.";
  const when = { baseUrlHosts: ["api.openai.com"] };
  const plan = planSuppressions({
    registry: registryFor(
      "openai",
      {
        aliases: {
          "azure-openai-responses": { provider: "openai" },
        },
        suppressions: [
          { provider: "openai", model, reason, when },
          { provider: "azure-openai-responses", model: "GPT-5.3-Codex-Spark", reason },
          { provider: "openrouter", model: "foreign-row" },
        ],
      },
      ["openai", "openai"],
    ),
  });

  const expected = { pluginId: "openai", model, reason };
  expect(plan.suppressions).toEqual([
    {
      ...expected,
      provider: "azure-openai-responses",
      mergeKey: `azure-openai-responses::${model}`,
    },
    { ...expected, provider: "openai", mergeKey: `openai::${model}`, when },
  ]);
});
