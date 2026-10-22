import type {
  ModelCatalogProvider,
  ModelInferenceCapabilities,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { describe, expect, it, vi } from "vitest";
import {
  planManifestModelCatalogRows,
  planManifestModelCatalogSuppressions,
} from "./manifest-planner.js";

type Registry = Parameters<typeof planManifestModelCatalogRows>[0]["registry"];
type Plugin = Registry["plugins"][number];
function makeRegistry(modelCatalog: Plugin["modelCatalog"], providers?: string[]): Registry {
  return { plugins: [{ id: "owner", providers, modelCatalog }] };
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

describe("manifest model catalog planner", () => {
  it("overlays only declared providers and keeps remote transport fields inert", () => {
    const remoteOverlay: Record<string, ModelCatalogProvider> = {
      anthropic: {
        api: "anthropic-messages",
        models: [{ id: "old", name: "Remote" }, { id: "new" }],
      },
      undeclared: { models: [{ id: "ignored" }] },
    };
    const params: Parameters<typeof planManifestModelCatalogRows>[0] = {
      registry: makeRegistry(
        {
          aliases: {
            "anthropic-alias": { provider: "anthropic", api: "anthropic-messages" },
          },
          providers: {
            anthropic: {
              api: "anthropic-messages",
              baseUrl: "https://api.anthropic.com",
              models: [
                {
                  id: "old",
                  name: "Bundled",
                  baseUrl: "https://model.api.anthropic.com",
                  headers: { "X-Trusted": "yes" },
                },
                { id: "kept" },
              ],
            },
          },
        },
        ["anthropic"],
      ),
      resolveRemoteProvider: (provider) => remoteOverlay[provider],
    };
    const plan = planManifestModelCatalogRows(params);
    expect(
      plan.rows.map((row) => [row.id, row.name, row.source, row.baseUrl, row.headers]),
    ).toEqual([
      ["kept", "kept", "manifest", "https://api.anthropic.com", undefined],
      ["new", "new", "runtime-refresh", "https://api.anthropic.com", undefined],
      [
        "old",
        "Remote",
        "runtime-refresh",
        "https://model.api.anthropic.com",
        { "X-Trusted": "yes" },
      ],
    ]);
    const emptyOverlay = { api: "openai-completions", models: [] } satisfies ModelCatalogProvider;
    const emptyRemotePlan = planManifestModelCatalogRows({
      ...params,
      resolveRemoteProvider: () => emptyOverlay,
    });
    expect(emptyRemotePlan.rows.map((row) => [row.id, row.source, row.api, row.baseUrl])).toEqual([
      ["kept", "manifest", "openai-completions", "https://api.anthropic.com"],
      ["old", "manifest", "openai-completions", "https://model.api.anthropic.com"],
    ]);
    const absentRemotePlan = planManifestModelCatalogRows({
      ...params,
      resolveRemoteProvider: () => undefined,
    });
    expect(absentRemotePlan.rows.map((row) => row.api)).toEqual([
      "anthropic-messages",
      "anthropic-messages",
    ]);
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
    const routeRegistry = makeRegistry(
      {
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
      },
      ["fixture"],
    );

    it.each([
      { provider: "same", expected: inference },
      { provider: "endpoint", expected: { chat: false } },
      { provider: "protocol", expected: { chat: false } },
    ])("binds alias facts to the effective route: $provider", ({ provider, expected }) => {
      const plan = planManifestModelCatalogRows({
        registry: routeRegistry,
        providerFilter: provider,
      });
      expect(plan.rows).toHaveLength(1);
      expect(plan.rows[0]?.inference).toEqual(expected);
    });

    it("retains matching hosted facts when a remote row replaces its label", () => {
      const plan = planManifestModelCatalogRows({
        registry: routeRegistry,
        resolveRemoteProvider: () => ({ models: [{ id: "typed", name: "Refreshed" }] }),
      });
      expect(plan.rows).toMatchObject([
        { name: "Refreshed", source: "runtime-refresh", inference },
      ]);
    });

    it.each([{ models: [] }, { models: [{ id: "typed", name: "Refreshed" }] }])(
      "clears facts when remote provider defaults change the effective API: %j",
      ({ models }) => {
        const plan = planManifestModelCatalogRows({
          registry: routeRegistry,
          resolveRemoteProvider: () => ({ api: "openai-completions", models }),
        });
        expect(plan.rows).toMatchObject([
          { api: "openai-completions", inference: { chat: false } },
        ]);
      },
    );

    it.each([
      { baseUrl: "https://remote.invalid/v1", models: [{ id: "typed", inference }] },
      { models: [{ id: "typed", baseUrl: "https://remote.invalid/v1", inference }] },
    ])("does not attach remote declarations to a retained trusted endpoint: %j", (remote) => {
      const plan = planManifestModelCatalogRows({
        registry: routeRegistry,
        resolveRemoteProvider: () => remote,
      });
      expect(plan.rows).toMatchObject([
        { baseUrl: "https://fixture.invalid/v1", inference: { chat: false } },
      ]);
    });

    it("replaces a hosted contract as a whole when remote metadata supplies one", () => {
      const replacement = { chat: true };
      const plan = planManifestModelCatalogRows({
        registry: routeRegistry,
        resolveRemoteProvider: () => ({ models: [{ id: "typed", inference: replacement }] }),
      });
      expect(plan.rows[0]?.inference).toEqual(replacement);
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
    const params: Parameters<typeof planManifestModelCatalogRows>[0] = {
      registry: {
        plugins: [
          {
            id: "anthropic",
            providers: ["anthropic"],
            modelCatalog: {
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
            },
          },
          {
            id: "unrelated",
            providers: ["unrelated"],
            modelCatalog: {
              providers: { unrelated: { models: [{ id: "unrelated" }] } },
            },
          },
        ],
      },
      providerFilters: ["anthropic-alias"],
      mergeKeyFilter: new Set(["anthropic-alias::requested"]),
      resolveRemoteProvider,
    };
    const plan = planManifestModelCatalogRows(params);

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
    expect(planManifestModelCatalogRows({ ...params, providerFilters: [] })).toStrictEqual({
      entries: [],
      rows: [],
      conflicts: [],
    });
    expect(resolveRemoteProvider.mock.calls).toEqual([]);
    expect(planManifestModelCatalogRows({ ...params, mergeKeyFilter: new Set() })).toStrictEqual({
      entries: [],
      rows: [],
      conflicts: [],
    });
    expect(resolveRemoteProvider.mock.calls).toEqual([["anthropic"]]);
  });

  it("selects static rows at their owning catalog boundary", () => {
    const providers = [
      ["static-provider", "static"],
      ["refreshable-provider", "refreshable"],
      ["runtime-provider", "runtime"],
    ] as const;
    const registry = {
      plugins: providers.map(([provider, discovery]) => ({
        id: provider,
        providers: [provider],
        modelCatalog: {
          providers: { [provider]: { models: [{ id: "known" }] } },
          discovery: { [provider]: discovery },
        },
      })),
    };
    const remoteOverlay = Object.fromEntries(
      providers.map(([provider]) => [provider, { models: [{ id: "refreshed" }] }]),
    );
    const refsFor = (selection?: Parameters<typeof planManifestModelCatalogRows>[0]["selection"]) =>
      planManifestModelCatalogRows({
        registry,
        resolveRemoteProvider: (provider) => remoteOverlay[provider],
        ...(selection ? { selection } : {}),
      }).rows.map((row) => row.ref);

    expect(refsFor()).toEqual([
      "refreshable-provider/known",
      "refreshable-provider/refreshed",
      "runtime-provider/known",
      "runtime-provider/refreshed",
      "static-provider/known",
      "static-provider/refreshed",
    ]);
    expect(refsFor("static")).toEqual(["static-provider/known", "static-provider/refreshed"]);
  });

  it("keeps conflicting model rows excluded from every catalog selection", () => {
    const registry = {
      plugins: (["static", "runtime"] as const).map((discovery) => ({
        id: `${discovery}-owner`,
        modelCatalog: {
          providers: {
            shared: {
              models:
                discovery === "static"
                  ? [{ id: "conflicted" }, { id: "kept", name: "Kept" }]
                  : [{ id: "CONFLICTED" }],
            },
          },
          discovery: { shared: discovery },
        },
      })),
    };

    for (const selection of [undefined, "static"] as const) {
      const plan = planManifestModelCatalogRows({
        registry,
        ...(selection ? { selection } : {}),
      });
      expect(plan.entries).toHaveLength(2);
      expect(plan.rows, selection).toEqual([{ ...expectedRow("shared", "kept"), name: "Kept" }]);
      expect(plan.conflicts, selection).toEqual([{ provider: "shared", modelId: "conflicted" }]);
    }
  });

  // Regression for #73876: an OpenRouter org slug must resolve to the direct provider.
  it("plans moonshotai alias rows from the moonshot provider catalog", () => {
    const plan = planManifestModelCatalogRows({
      providerFilter: "moonshotai",
      registry: makeRegistry(
        {
          aliases: {
            moonshotai: {
              provider: "moonshot",
            },
            "moonshot-ai": {
              provider: "moonshot",
            },
          },
          discovery: {
            moonshot: "static",
          },
          providers: {
            Moonshot: {
              api: "openai-completions",
              baseUrl: "https://api.moonshot.ai/v1",
              models: [
                {
                  id: "kimi-k2.6",
                  name: "Kimi K2.6",
                  input: ["text", "image"],
                  contextWindow: 256000,
                },
              ],
            },
          },
        },
        ["moonshot"],
      ),
    });

    const rows = [
      {
        ...expectedRow("moonshotai", "kimi-k2.6"),
        name: "Kimi K2.6",
        input: ["text", "image"],
        contextWindow: 256000,
        api: "openai-completions",
        baseUrl: "https://api.moonshot.ai/v1",
      },
    ];
    expect(plan.entries).toEqual([{ provider: "moonshotai", discovery: "static", rows }]);
    expect(plan.rows).toEqual(rows);
    expect(plan.conflicts).toEqual([]);
  });

  it("sorts fresh normalized rows without mutating frozen manifest inputs", () => {
    const models = [{ id: "z" }, { id: "a" }];
    models.forEach(Object.freeze);
    Object.freeze(models);
    const frozenRegistry = makeRegistry({ providers: { fixture: { models } } });
    const plan = planManifestModelCatalogRows({ registry: frozenRegistry });
    const repeated = planManifestModelCatalogRows({ registry: frozenRegistry });
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
    const plan = planManifestModelCatalogRows({
      registry: makeRegistry({
        providers: { fixture: { models: [{ id: " a ", name: "Local" }] } },
      }),
      resolveRemoteProvider: () => ({ models: [{ id: "a", name: "Remote" }] }),
    });
    expect(plan.entries[0]?.rows.map((row) => [row.id, row.name, row.source])).toEqual([
      ["a", "Local", "manifest"],
      ["a", "Remote", "runtime-refresh"],
    ]);
    expect(plan.rows).toEqual([]);
    expect(plan.conflicts).toStrictEqual([
      {
        provider: "fixture",
        modelId: "a",
      },
    ]);
  });
});

describe("manifest model catalog suppression planner", () => {
  it("plans suppressions for owned providers and declared provider aliases", () => {
    const model = "gpt-5.3-codex-spark";
    const reason = "Use openai/gpt-5.5.";
    const when = { baseUrlHosts: ["api.openai.com"] };
    const plan = planManifestModelCatalogSuppressions({
      registry: {
        plugins: [
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
        ],
      },
    });

    const common = { pluginId: "openai", model, reason };
    expect(plan.suppressions).toEqual([
      {
        ...common,
        provider: "azure-openai-responses",
        mergeKey: `azure-openai-responses::${model}`,
      },
      { ...common, provider: "openai", mergeKey: `openai::${model}`, when },
    ]);
  });
});
