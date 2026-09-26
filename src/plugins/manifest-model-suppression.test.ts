// Verifies manifest-driven model suppression behavior.
import fs from "node:fs";
import {
  normalizeModelCatalog,
  normalizeModelCatalogProviderRows,
} from "@openclaw/model-catalog-core/model-catalog-normalize";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { projectModelProviderConfig } from "../config/model-provider-config.js";

const mocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

import { buildManifestBuiltInModelSuppressionResolver } from "./manifest-model-suppression.js";
import { createPluginCache, getPluginCache, withPluginCache } from "./plugin-cache.js";

function createMetadataSnapshot(plugins: Record<string, unknown>[]) {
  return {
    index: { plugins: [] },
    diagnostics: [],
    plugins: plugins.map((plugin) => ({ origin: "bundled", ...plugin })),
  };
}

describe("manifest model suppression", () => {
  beforeEach(() => {
    mocks.loadPluginMetadataSnapshot.mockReset();
    mocks.loadPluginMetadataSnapshot.mockReturnValue(
      createMetadataSnapshot([
        {
          id: "openai",
          providers: ["openai"],
          modelCatalog: {
            aliases: {
              "azure-openai-responses": {
                provider: "openai",
              },
            },
            suppressions: [
              {
                provider: "azure-openai-responses",
                model: "gpt-5.3-codex-spark",
                reason: "Use openai/gpt-5.5.",
              },
              {
                provider: "openrouter",
                model: "foreign-row",
              },
            ],
          },
        },
      ]),
    );
    mocks.resolvePluginMetadataSnapshot.mockImplementation(
      (params?: Parameters<typeof mocks.loadPluginMetadataSnapshot>[0]) =>
        mocks.loadPluginMetadataSnapshot(params),
    );
  });

  it("retains each exact snapshot's compiled rules across operation A/B/A interleaving", () => {
    const config = {};
    const ownerA = createPluginCache();
    const ownerB = createPluginCache();
    const snapshots = ["first rules", "second rules"].map((reason) =>
      createMetadataSnapshot([
        {
          id: "fixture",
          providers: ["fixture"],
          modelCatalog: { suppressions: [{ provider: "fixture", model: "model", reason }] },
        },
      ]),
    );
    mocks.loadPluginMetadataSnapshot.mockImplementation(() =>
      getPluginCache() === ownerA ? snapshots[0] : snapshots[1],
    );
    const build = () => buildManifestBuiltInModelSuppressionResolver({ config, env: process.env });
    const first = withPluginCache(ownerA, build);
    const second = withPluginCache(ownerB, build);
    expect(first({ provider: "fixture", id: "model" })?.errorMessage).toBe(
      "Unknown model: fixture/model. first rules",
    );
    expect(second({ provider: "fixture", id: "model" })?.errorMessage).toBe(
      "Unknown model: fixture/model. second rules",
    );
    expect(withPluginCache(ownerA, build)).toBe(first);
  });

  describe("buildManifestBuiltInModelSuppressionResolver", () => {
    it("traverses plugin policy once per compilation while preserving owner restrictions", () => {
      const ids = Array.from({ length: 8 }, (_, index) => `fixture-${index}`);
      let enumerations = 0;
      const entries = new Proxy(
        Object.fromEntries(ids.map((id) => [id, { enabled: id !== "fixture-1" }])),
        {
          ownKeys(target) {
            enumerations += 1;
            return Reflect.ownKeys(target);
          },
        },
      );
      const config = {
        plugins: {
          entries,
          allow: ids.filter((id) => id !== "fixture-7"),
          deny: ["fixture-2"],
        },
      };
      mocks.loadPluginMetadataSnapshot.mockReturnValue(
        createMetadataSnapshot(
          ids.map((id) => ({
            id,
            providers: [id],
            modelCatalog: { suppressions: [{ provider: id, model: "retired" }] },
          })),
        ),
      );
      const resolver = buildManifestBuiltInModelSuppressionResolver({ config });

      expect(ids.map((provider) => Boolean(resolver({ provider, id: "retired" })))).toEqual([
        true,
        false,
        false,
        true,
        true,
        true,
        true,
        false,
      ]);
      expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledTimes(1);
      expect(enumerations).toBe(1);
      expect(buildManifestBuiltInModelSuppressionResolver({ config })).toBe(resolver);
      expect(enumerations).toBe(1);

      const changedConfig = {
        plugins: { ...config.plugins, deny: ["fixture-2", "fixture-4"] },
      };
      const changedResolver = buildManifestBuiltInModelSuppressionResolver({
        config: changedConfig,
      });
      expect(changedResolver({ provider: "fixture-4", id: "retired" })).toBeUndefined();
      expect(resolver({ provider: "fixture-4", id: "retired" })?.suppress).toBe(true);
      expect(enumerations).toBe(2);
    });
  });

  it("resolves manifest suppressions for declared provider aliases", () => {
    const resolver = buildManifestBuiltInModelSuppressionResolver({ env: process.env });

    expect(
      resolver({
        provider: "azure-openai-responses",
        id: "GPT-5.3-Codex-Spark",
      }),
    ).toEqual({
      suppress: true,
      errorMessage:
        "Unknown model: azure-openai-responses/gpt-5.3-codex-spark. Use openai/gpt-5.5.",
    });
  });

  it("ignores suppressions for providers the plugin does not own", () => {
    const resolver = buildManifestBuiltInModelSuppressionResolver({ env: process.env });

    expect(
      resolver({
        provider: "openrouter",
        id: "foreign-row",
      }),
    ).toBeUndefined();
  });

  it("preserves ordered same-model rules and current route conditions", () => {
    const config = {
      models: {
        providers: {
          fixture: {
            api: "openai-completions" as const,
            baseUrl: "https://first.example/v1",
            models: [],
          },
        },
      },
    };
    mocks.loadPluginMetadataSnapshot.mockReturnValue(
      createMetadataSnapshot([
        {
          id: "z-fallback",
          providers: ["fixture"],
          modelCatalog: {
            suppressions: [{ provider: "fixture", model: "model", reason: "Fallback." }],
          },
        },
        {
          id: "a-conditional",
          providers: ["fixture"],
          modelCatalog: {
            suppressions: [
              {
                provider: "fixture",
                model: "model",
                reason: "First route.",
                when: {
                  baseUrlHosts: ["FIRST.EXAMPLE.", "shared.example"],
                  providerConfigApiIn: ["OPENAI-COMPLETIONS"],
                },
              },
              {
                provider: "fixture",
                model: "model",
                reason: "Second route.",
                retirement: { replacedBy: "successor" },
                when: { baseUrlHosts: ["second.example", "shared.example"] },
              },
            ],
          },
        },
      ]),
    );
    const resolver = buildManifestBuiltInModelSuppressionResolver({ config });
    const input = { provider: "fixture", id: "model" };

    expect(resolver({ ...input, baseUrl: "https://shared.example/v1" })).toEqual({
      suppress: true,
      errorMessage: "Unknown model: fixture/model. First route.",
    });
    expect(resolver({ ...input, baseUrl: "https://second.example/v1" })).toMatchObject({
      retirement: { replacedBy: "successor" },
    });
    for (const baseUrl of ["https://other.example/v1", "invalid endpoint"]) {
      expect(resolver({ ...input, baseUrl })?.errorMessage).toBe(
        "Unknown model: fixture/model. Fallback.",
      );
    }
    expect(
      resolver({ ...input, baseUrl: "https://shared.example/v1", unconditionalOnly: true })
        ?.errorMessage,
    ).toBe("Unknown model: fixture/model. Fallback.");
    expect(resolver(input)?.errorMessage).toBe("Unknown model: fixture/model. First route.");
    config.models.providers.fixture.baseUrl = "https://second.example/v1";
    expect(resolver(input)).toEqual({
      suppress: true,
      errorMessage: "Unknown model: fixture/model. Fallback.",
    });
  });

  it.each([undefined, "current-model"])(
    "preserves explicit retirement and successor %s only on the selected endpoint",
    (replacedBy) => {
      const modelCatalog = normalizeModelCatalog(
        {
          suppressions: [
            {
              provider: "fixture",
              model: "old-model",
              reason: "This subscription model has retired.",
              retirement: replacedBy ? { replacedBy } : {},
              when: { baseUrlHosts: ["subscription.example"] },
            },
          ],
        },
        { ownedProviders: new Set(["fixture"]) },
      );
      mocks.loadPluginMetadataSnapshot.mockReturnValue(
        createMetadataSnapshot([{ id: "fixture", providers: ["fixture"], modelCatalog }]),
      );
      const resolver = buildManifestBuiltInModelSuppressionResolver({ env: process.env });
      const retired = resolver({
        provider: "fixture",
        id: "old-model",
        baseUrl: "https://subscription.example/v1",
      });
      expect(retired).toMatchObject({
        suppress: true,
        retirement: replacedBy ? { replacedBy } : {},
      });
      expect(retired?.errorMessage).toContain("openclaw doctor --fix");
      expect(resolver({ provider: "fixture", id: "old-model" })).toBeUndefined();
      expect(
        resolver({ provider: "fixture", id: "old-model", baseUrl: "https://api.example/v1" }),
      ).toBeUndefined();
      expect(
        resolver({
          provider: "fixture",
          id: "current-model",
          baseUrl: "https://subscription.example/v1",
        }),
      ).toBeUndefined();
    },
  );

  it("reuses planned manifest suppressions inside a resolver instance", () => {
    const config = { plugins: { entries: { openai: { enabled: true } } } };

    const resolver = buildManifestBuiltInModelSuppressionResolver({
      config,
      env: process.env,
    });

    expect(
      resolver({
        provider: "azure-openai-responses",
        id: "gpt-5.3-codex-spark",
      })?.suppress,
    ).toBe(true);
    expect(
      resolver({
        provider: "azure-openai-responses",
        id: "gpt-4.1",
      }),
    ).toBeUndefined();
    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "native", baseUrl: "https://api.x.ai/v1", id: "auto", retired: true },
    { name: "custom", baseUrl: "https://custom.invalid/v1", id: "auto", retired: false },
    { name: "private ID", baseUrl: "https://api.x.ai/v1", id: "private-model", retired: false },
    { name: "ambiguous", baseUrl: "https://api.x.ai/v1", id: "auto", retired: false },
    { name: "owned logical provider", baseUrl: "https://api.x.ai/v1", id: "auto", retired: false },
    { name: "model override", baseUrl: "https://custom.invalid/v1", id: "auto", retired: false },
  ])("applies captured physical retirement policy for $name", (scenario) => {
    const native = { api: "openai-responses", baseUrl: "https://api.x.ai/v1", models: [] };
    const plugins: Record<string, unknown>[] = [
      {
        id: "xai",
        providers: ["xai"],
        providerEndpoints: [{ endpointClass: "xai-native", hosts: ["api.x.ai"] }],
        modelCatalog: {
          providers: { xai: native },
          suppressions: [
            {
              provider: "xai",
              model: "auto",
              retirement: { replacedBy: "current" },
              when: { baseUrlHosts: ["api.x.ai"] },
            },
          ],
        },
      },
    ];
    if (scenario.name === "ambiguous") {
      plugins.push({
        id: "other",
        providers: ["other"],
        modelCatalog: { providers: { other: native } },
      });
    }
    if (scenario.name === "owned logical provider") {
      plugins.push({ id: "personal", providers: ["personal"] });
    }
    mocks.loadPluginMetadataSnapshot.mockReturnValue(createMetadataSnapshot(plugins));
    const config = {
      models: {
        providers: {
          personal: {
            api: "openai-responses" as const,
            baseUrl: scenario.name === "model override" ? native.baseUrl : scenario.baseUrl,
            models: [
              makeProviderModelFixture<"openai-responses">({
                id: scenario.id,
                name: scenario.id,
                provider: "personal",
                api: "openai-responses",
                baseUrl: scenario.baseUrl,
              }),
            ].map(({ provider: _provider, api: _api, ...model }) => model),
          },
        },
      },
    };
    const resolver = buildManifestBuiltInModelSuppressionResolver({ config });
    const input = { provider: "personal", id: scenario.id };
    expect(resolver.hasRetirementCandidate(input)).toBe(scenario.retired);
    const result = resolver({ ...input, baseUrl: scenario.baseUrl });
    expect(Boolean(result?.retirement)).toBe(scenario.retired);
    if (scenario.retired) {
      expect(result?.errorMessage).toContain("personal/auto");
    }
    expect(
      resolver({ ...input, baseUrl: scenario.baseUrl, unconditionalOnly: true }),
    ).toBeUndefined();
    expect(resolver({ provider: "xai", id: "auto", baseUrl: native.baseUrl })?.retirement).toEqual({
      replacedBy: "current",
    });
  });

  it("uses the model-level API for physical retirement candidate knowledge", () => {
    const baseUrl = "https://api.x.ai/v1";
    mocks.loadPluginMetadataSnapshot.mockReturnValue(
      createMetadataSnapshot([
        {
          id: "xai",
          providers: ["xai"],
          providerEndpoints: [{ endpointClass: "xai-native", hosts: ["api.x.ai"] }],
          modelCatalog: {
            providers: { xai: { api: "openai-responses", baseUrl, models: [] } },
            suppressions: [
              {
                provider: "xai",
                model: "auto",
                retirement: { replacedBy: "current" },
                when: { baseUrlHosts: ["api.x.ai"], providerConfigApiIn: ["openai-responses"] },
              },
            ],
          },
        },
      ]),
    );
    const config = {
      models: {
        providers: {
          personal: {
            api: "openai-completions" as const,
            baseUrl,
            models: [
              makeProviderModelFixture<"openai-responses">({
                id: "auto",
                name: "Auto",
                provider: "personal",
                api: "openai-responses",
                baseUrl,
              }),
            ].map(({ provider: _provider, baseUrl: _baseUrl, ...model }) => model),
          },
        },
      },
    };
    const resolver = buildManifestBuiltInModelSuppressionResolver({ config });
    const input = { provider: "personal", id: "auto", baseUrl };
    expect(resolver.hasRetirementCandidate(input)).toBe(true);
    expect(resolver(input)).toBeUndefined();
    const selected = projectModelProviderConfig(config, "personal", {
      api: "openai-responses",
      baseUrl,
    });
    expect(
      buildManifestBuiltInModelSuppressionResolver({ config: selected })(input)?.retirement,
    ).toEqual({ replacedBy: "current" });
    Object.defineProperty(config.models.providers.personal, "models", {
      get() {
        throw new Error("Nonretired model knowledge must not read configured rows");
      },
    });
    expect(resolver.hasRetirementCandidate({ provider: "personal", id: "private-model" })).toBe(
      false,
    );
  });

  it("keeps the OpenAI API route available while retiring the ChatGPT route", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        new URL("../../extensions/openai/openclaw.plugin.json", import.meta.url),
        "utf8",
      ),
    );
    mocks.loadPluginMetadataSnapshot.mockReturnValue(createMetadataSnapshot([manifest]));
    const resolver = buildManifestBuiltInModelSuppressionResolver({ env: process.env });
    const input = { provider: "openai", id: "gpt-5.4" };
    expect(resolver({ ...input, baseUrl: "https://chatgpt.com/backend-api" })).toMatchObject({
      retirement: { replacedBy: "gpt-5.6-terra" },
    });
    for (const baseUrl of [undefined, "https://api.openai.com/v1", "https://proxy.example/v1"]) {
      expect(resolver({ ...input, baseUrl })).toBeUndefined();
    }
  });

  it.each([
    "subscription.example",
    { baseUrlHosts: [] },
    { baseUrlHosts: 42 },
    { baseUrlHosts: ["subscription.example"], providerConfigApiIn: false },
  ])("does not broaden malformed retirement scope %# into a global rule", (when) => {
    const catalog = normalizeModelCatalog(
      { suppressions: [{ provider: "fixture", model: "old", retirement: {}, when }] },
      { ownedProviders: new Set(["fixture"]) },
    );
    expect(catalog?.suppressions).toBeUndefined();
  });

  it("matches conditional suppressions by base URL host", () => {
    mocks.loadPluginMetadataSnapshot.mockReturnValue(
      createMetadataSnapshot([
        {
          id: "qwen",
          providers: ["qwen", "modelstudio"],
          modelCatalog: {
            suppressions: [
              {
                provider: "qwen",
                model: "qwen3.6-plus",
                reason: "Use qwen/qwen3.5-plus.",
                when: {
                  baseUrlHosts: [
                    "coding.dashscope.aliyuncs.com",
                    "coding-intl.dashscope.aliyuncs.com",
                  ],
                  providerConfigApiIn: ["qwen", "modelstudio"],
                },
              },
            ],
          },
        },
      ]),
    );
    const resolver = buildManifestBuiltInModelSuppressionResolver({ env: process.env });

    expect(
      resolver({
        provider: "qwen",
        id: "qwen3.6-plus",
        baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      })?.suppress,
    ).toBe(true);
    expect(
      resolver({
        provider: "qwen",
        id: "qwen3.6-plus",
        baseUrl: " https://coding-intl.dashscope.aliyuncs.com./v1 ",
      })?.suppress,
    ).toBe(true);
    expect(
      resolver({
        provider: "qwen",
        id: "qwen3.6-plus",
      })?.suppress,
    ).toBe(true);
    expect(
      resolver({
        provider: "qwen",
        id: "qwen3.6-plus",
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      }),
    ).toBeUndefined();
  });

  it("does not apply conditional suppressions to custom providers with a foreign api owner", () => {
    mocks.loadPluginMetadataSnapshot.mockReturnValue(
      createMetadataSnapshot([
        {
          id: "qwen",
          providers: ["modelstudio"],
          modelCatalog: {
            suppressions: [
              {
                provider: "modelstudio",
                model: "qwen3.6-plus",
                when: {
                  baseUrlHosts: ["coding-intl.dashscope.aliyuncs.com"],
                  providerConfigApiIn: ["qwen", "modelstudio"],
                },
              },
            ],
          },
        },
      ]),
    );
    const resolver = buildManifestBuiltInModelSuppressionResolver({
      config: {
        models: {
          providers: {
            modelstudio: {
              api: "openai-completions",
              baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
              models: [],
            },
          },
        },
      },
      env: process.env,
    });

    expect(
      resolver({
        provider: "modelstudio",
        id: "qwen3.6-plus",
      }),
    ).toBeUndefined();
  });

  it("does not apply provider api conditional suppressions when a configured provider omits api", () => {
    mocks.loadPluginMetadataSnapshot.mockReturnValue(
      createMetadataSnapshot([
        {
          id: "qwen",
          providers: ["modelstudio"],
          modelCatalog: {
            suppressions: [
              {
                provider: "modelstudio",
                model: "qwen3.6-plus",
                when: {
                  baseUrlHosts: ["coding-intl.dashscope.aliyuncs.com"],
                  providerConfigApiIn: ["qwen", "modelstudio"],
                },
              },
            ],
          },
        },
      ]),
    );
    const resolver = buildManifestBuiltInModelSuppressionResolver({
      config: {
        models: {
          providers: {
            modelstudio: {
              baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
              models: [],
            },
          },
        },
      },
      env: process.env,
    });

    expect(
      resolver({
        provider: "modelstudio",
        id: "qwen3.6-plus",
      }),
    ).toBeUndefined();
  });

  it.each([
    ["qwen", "https://coding.dashscope.aliyuncs.com/v1", true],
    ["modelstudio", "https://coding-intl.dashscope.aliyuncs.com/v1", true],
    ["qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", false],
    ["modelstudio", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", false],
    ["qwen", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", false],
    ["modelstudio", "https://proxy.example/v1", false],
  ] as const)("matches %s plan availability at %s", (provider, baseUrl, suppressed) => {
    const qwenManifest: Record<string, unknown> = JSON.parse(
      fs.readFileSync(
        new URL("../../extensions/qwen/openclaw.plugin.json", import.meta.url),
        "utf8",
      ),
    );
    mocks.loadPluginMetadataSnapshot.mockReturnValue(createMetadataSnapshot([qwenManifest]));
    const providerCatalog = normalizeModelCatalog(qwenManifest.modelCatalog, {
      ownedProviders: new Set(["qwen"]),
    })?.providers?.qwen;
    if (!providerCatalog) {
      throw new Error("Qwen manifest catalog is missing");
    }
    const rows = normalizeModelCatalogProviderRows({
      provider,
      providerCatalog,
      source: "manifest",
    });
    const resolver = buildManifestBuiltInModelSuppressionResolver({
      config: { models: { providers: { [provider]: { baseUrl, models: [] } } } },
      env: process.env,
    });

    for (const id of ["qwen3.6-flash", "qwen3.7-max", "qwen3.8-max", "qwen3.8-flash"]) {
      const row = rows.find((entry) => entry.id === id);
      expect(row, id).toBeDefined();
      expect(Boolean(resolver({ provider, id, baseUrl: row?.baseUrl })?.suppress), id).toBe(
        suppressed,
      );
    }
    expect(resolver({ provider, id: "qwen3.7-plus" })).toBeUndefined();
  });
});
