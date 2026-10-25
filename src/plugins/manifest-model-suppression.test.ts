import fs from "node:fs";
import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { projectModelProviderConfig } from "../config/model-provider-config.js";
import type { ModelProviderConfig } from "../config/types.models.js";

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

function setPlugins(...plugins: Record<string, unknown>[]) {
  mocks.loadPluginMetadataSnapshot.mockReturnValue(createMetadataSnapshot(plugins));
}

function suppressionPlugin(id: string, suppressions: Record<string, unknown>[], providers = [id]) {
  return { id, providers, modelCatalog: { suppressions } };
}

function providerConfig(provider: string, config: ModelProviderConfig) {
  return { models: { providers: { [provider]: config } } };
}
const suppressed = (reason: string) => ({
  suppress: true,
  errorMessage: `Unknown model: fixture/model. ${reason}`,
});

const native = { api: "openai-responses", baseUrl: "https://api.x.ai/v1", models: [] };
const personalModel = makeProviderModelFixture<"openai-responses">({
  id: "auto",
  name: "Auto",
  provider: "personal",
  api: "openai-responses",
  baseUrl: native.baseUrl,
});
function nativePlugin(providerConfigApiIn?: string[], endpointUrl = false) {
  return {
    id: "xai",
    providers: ["xai"],
    providerEndpoints: endpointUrl
      ? [
          {
            endpointClass: "future-endpoint",
            baseUrls: ["HTTPS://API.X.AI/V1/?ignored=1#fragment"],
          },
        ]
      : [{ endpointClass: "xai-native", hosts: ["api.x.ai"] }],
    modelCatalog: {
      providers: { xai: native },
      suppressions: [
        {
          provider: "xai",
          model: "auto",
          retirement: { replacedBy: "current" },
          when: { baseUrlHosts: ["api.x.ai"], ...(providerConfigApiIn && { providerConfigApiIn }) },
        },
      ],
    },
  };
}

describe("manifest model suppression", () => {
  beforeEach(() => {
    mocks.loadPluginMetadataSnapshot.mockReset();
    mocks.resolvePluginMetadataSnapshot.mockImplementation(mocks.loadPluginMetadataSnapshot);
  });

  it("retains each exact snapshot's compiled rules across operation A/B/A interleaving", () => {
    const config = {};
    const ownerA = createPluginCache();
    const ownerB = createPluginCache();
    const snapshots = ["first rules", "second rules"].map((reason) =>
      createMetadataSnapshot([
        suppressionPlugin("fixture", [{ provider: "fixture", model: "model", reason }]),
      ]),
    );
    mocks.loadPluginMetadataSnapshot.mockImplementation(() =>
      getPluginCache() === ownerA ? snapshots[0] : snapshots[1],
    );
    const build = () => buildManifestBuiltInModelSuppressionResolver({ config, env: process.env });
    const first = withPluginCache(ownerA, build);
    const second = withPluginCache(ownerB, build);
    expect(first({ provider: "fixture", id: "model" })).toEqual(suppressed("first rules"));
    expect(second({ provider: "fixture", id: "model" })).toEqual(suppressed("second rules"));
    expect(withPluginCache(ownerA, build)).toBe(first);
  });

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
    setPlugins(...ids.map((id) => suppressionPlugin(id, [{ provider: id, model: "retired" }])));
    const resolver = buildManifestBuiltInModelSuppressionResolver({ config });

    expect(ids.filter((provider) => resolver({ provider, id: "retired" }))).toEqual([
      "fixture-0",
      "fixture-3",
      "fixture-4",
      "fixture-5",
      "fixture-6",
    ]);
    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledTimes(1);
    expect(enumerations).toBe(1);
    expect(buildManifestBuiltInModelSuppressionResolver({ config })).toBe(resolver);
    expect(enumerations).toBe(1);

    const changedResolver = buildManifestBuiltInModelSuppressionResolver({
      config: { plugins: { ...config.plugins, deny: ["fixture-2", "fixture-4"] } },
    });
    expect(changedResolver({ provider: "fixture-4", id: "retired" })).toBeUndefined();
    expect(resolver({ provider: "fixture-4", id: "retired" })?.suppress).toBe(true);
    expect(enumerations).toBe(2);
  });

  it("preserves ordered same-model rules and current route conditions", () => {
    const fixture = {
      api: "openai-completions" as const,
      baseUrl: "https://first.example/v1",
      models: [],
    };
    const config = providerConfig("fixture", fixture);
    setPlugins(
      suppressionPlugin(
        "z-fallback",
        [{ provider: "fixture", model: "model", reason: "Fallback." }],
        ["fixture"],
      ),
      suppressionPlugin(
        "a-conditional",
        [
          {
            provider: "fixture",
            model: "model",
            reason: "First route.",
            when: {
              baseUrlHosts: ["FIRST.EXAMPLE.", "shared.example"],
              providerConfigApiIn: ["OPENAI-COMPLETIONS", "fixture"],
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
        ["fixture"],
      ),
    );
    const resolver = buildManifestBuiltInModelSuppressionResolver({ config });
    const input = { provider: "fixture", id: "model" };

    expect(resolver({ ...input, baseUrl: "https://shared.example/v1" })).toEqual(
      suppressed("First route."),
    );
    expect(resolver({ ...input, baseUrl: " https://first.example./v1 " })).toEqual(
      suppressed("First route."),
    );
    expect(buildManifestBuiltInModelSuppressionResolver({})(input)).toEqual(
      suppressed("First route."),
    );
    expect(resolver({ ...input, baseUrl: "https://second.example/v1" })).toMatchObject({
      retirement: { replacedBy: "successor" },
    });
    for (const baseUrl of ["https://other.example/v1", "invalid endpoint"]) {
      expect(resolver({ ...input, baseUrl })).toEqual(suppressed("Fallback."));
    }
    expect(
      resolver({ ...input, baseUrl: "https://shared.example/v1", unconditionalOnly: true }),
    ).toEqual(suppressed("Fallback."));
    expect(resolver(input)).toEqual(suppressed("First route."));
    fixture.baseUrl = "https://second.example/v1";
    expect(resolver(input)).toEqual(suppressed("Fallback."));
  });

  it.each([undefined, "current-model"])(
    "preserves explicit retirement and successor %s only on the selected endpoint",
    (replacedBy) => {
      const retirement = replacedBy ? { replacedBy } : {};
      const modelCatalog = normalizeModelCatalog(
        {
          suppressions: [
            {
              provider: "fixture",
              model: "old-model",
              reason: "This subscription model has retired.",
              retirement,
              when: { baseUrlHosts: ["subscription.example"] },
            },
          ],
        },
        { ownedProviders: new Set(["fixture"]) },
      );
      setPlugins({ id: "fixture", providers: ["fixture"], modelCatalog });
      const resolver = buildManifestBuiltInModelSuppressionResolver({ env: process.env });
      const input = { provider: "fixture", id: "old-model" };
      const baseUrl = "https://subscription.example/v1";
      const retired = resolver({ ...input, baseUrl });
      expect(retired).toMatchObject({ suppress: true, retirement });
      expect(retired?.errorMessage).toContain("openclaw doctor --fix");
      expect(resolver(input)).toBeUndefined();
      expect(resolver({ ...input, baseUrl: "https://api.example/v1" })).toBeUndefined();
      expect(resolver({ ...input, id: "current-model", baseUrl })).toBeUndefined();
    },
  );

  it.each([
    { name: "native", baseUrl: "https://api.x.ai/v1", id: "auto", retired: true },
    { name: "native endpoint URL", baseUrl: "https://api.x.ai/v1", id: "auto", retired: true },
    { name: "custom", baseUrl: "https://custom.invalid/v1", id: "auto", retired: false },
    { name: "private ID", baseUrl: "https://api.x.ai/v1", id: "private-model", retired: false },
    { name: "ambiguous", baseUrl: "https://api.x.ai/v1", id: "auto", retired: false },
    { name: "owned logical provider", baseUrl: "https://api.x.ai/v1", id: "auto", retired: false },
    { name: "model override", baseUrl: "https://custom.invalid/v1", id: "auto", retired: false },
  ])("applies captured physical retirement policy for $name", (scenario) => {
    const plugins: Record<string, unknown>[] = [
      nativePlugin(undefined, scenario.name === "native endpoint URL"),
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
    setPlugins(...plugins);
    const config = providerConfig("personal", {
      api: "openai-responses",
      baseUrl: scenario.name === "model override" ? native.baseUrl : scenario.baseUrl,
      models: [
        {
          ...personalModel,
          id: scenario.id,
          name: scenario.id,
          baseUrl: scenario.baseUrl,
        },
      ].map(({ provider: _provider, api: _api, ...model }) => model),
    });
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
    setPlugins(nativePlugin(["openai-responses"]));
    const personal = {
      api: "openai-completions" as const,
      baseUrl,
      models: [personalModel].map(({ provider: _provider, baseUrl: _baseUrl, ...model }) => model),
    };
    const config = providerConfig("personal", personal);
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
    Object.defineProperty(personal, "models", {
      get() {
        throw new Error("Nonretired model knowledge must not read configured rows");
      },
    });
    expect(resolver.hasRetirementCandidate({ provider: "personal", id: "private-model" })).toBe(
      false,
    );
  });

  it("keeps the OpenAI API route available while retiring the ChatGPT route", () => {
    const manifestUrl = new URL("../../extensions/openai/openclaw.plugin.json", import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(manifestUrl, "utf8"));
    setPlugins(manifest);
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
});
