import { assert, expect, it, vi } from "vitest";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import { buildWebSearchProviderConfig } from "./test-helpers.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

// mock-isolation: Capture validation diagnostics without writing to the CLI runtime.
vi.mock("../runtime.js", () => ({ defaultRuntime: { log: vi.fn(), error: vi.fn() } }));

// mock-isolation: Validate the synthetic provider catalog, not installed operator plugins.
vi.mock("../plugins/manifest-registry.js", () => {
  const providers = Object.entries({ brave: "brave", gemini: "google" });
  const configSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      webSearch: {
        type: "object",
        additionalProperties: false,
        properties: { apiKey: { type: "string" } },
      },
    },
  };
  return {
    loadPluginManifestRegistryCore: () => ({
      plugins: [...providers, ["acme-search", "acme-search"] as const].map(([id, pluginId]) => ({
        id: pluginId,
        origin: id === "acme-search" ? "installed" : "bundled",
        channels: [],
        providers: [],
        contracts: { webSearchProviders: [id] },
        cliBackends: [],
        skills: [],
        hooks: [],
        rootDir: `/tmp/plugins/${pluginId}`,
        source: "test",
        manifestPath: `/tmp/plugins/${pluginId}/openclaw.plugin.json`,
        schemaCacheKey: `test:${pluginId}`,
        configSchema,
      })),
      diagnostics: [],
    }),
    resolveManifestContractPluginIds: (params?: { contract?: string; origin?: string }) =>
      params?.contract === "webSearchProviders" && params.origin === "bundled"
        ? providers
            .map(([, pluginId]) => pluginId)
            .toSorted((left, right) => left.localeCompare(right))
        : [],
    resolveManifestContractOwnerPluginId: (params?: { contract?: string; value?: string }) =>
      params?.contract === "webSearchProviders"
        ? providers.find(([id]) => id === params.value)?.[1]
        : undefined,
  };
});

const validateWebSearchConfig: typeof validateConfigObjectWithPlugins = (raw, params) =>
  validateConfigObjectWithPlugins(raw, {
    pluginMetadataSnapshot: { manifestRegistry: loadPluginManifestRegistryCore() },
    ...params,
  });
const missingPlugins = {
  pluginMetadataSnapshot: { manifestRegistry: { plugins: [], diagnostics: [] } },
};

function searchConfig(provider: string, providerConfig?: Record<string, unknown>) {
  return buildWebSearchProviderConfig({ provider, providerConfig });
}

it("allows bundled web search config outside the explicit plugin allowlist", () => {
  const res = validateWebSearchConfig({
    ...searchConfig("brave"),
    plugins: {
      allow: ["imessage", "memory-core"],
      entries: { brave: { config: { webSearch: { apiKey: "test-brave-key" } } } }, // pragma: allowlist secret
    },
  });
  expect(res.ok).toBe(true);
  expect(
    res.warnings.some(
      (warning) =>
        warning.path === "plugins.entries.brave" &&
        warning.message.includes("plugin disabled (not in allowlist) but config is present"),
    ),
  ).toBe(false);
});

it("detects legacy scoped provider config for bundled providers", () => {
  const search = { provider: "gemini", gemini: { apiKey: "legacy-key" } };
  expect(validateWebSearchConfig({ tools: { web: { search } } }).ok).toBe(false);
});

it("accepts provider ids registered by installed plugin manifests", () => {
  expect(validateWebSearchConfig(searchConfig("acme-search")).ok).toBe(true);
});

it.each([
  [
    "brave",
    missingPlugins,
    'web_search provider is not available: brave (install or enable plugin "brave", then run openclaw doctor --fix)',
    ["brave"],
  ],
  ["brvae", undefined, "unknown web_search provider: brvae", ["acme-search", "brave", "gemini"]],
] as const)("rejects unavailable provider %s", (provider, options, message, allowedValues) => {
  const result = validateWebSearchConfig(searchConfig(provider), options);
  assert(!result.ok);
  expect(result.issues).toContainEqual(
    expect.objectContaining({
      path: "tools.web.search.provider",
      message,
      allowedValues: expect.arrayContaining([...allowedValues]),
    }),
  );
});

it("warns for unavailable installable providers with stale plugin config", () => {
  const res = validateWebSearchConfig(searchConfig("brave", {}), missingPlugins);
  expect(res.ok).toBe(true);
  const warning = res.warnings.find((entry) => entry.path === "tools.web.search.provider");
  expect(warning?.message).toContain("web_search provider is not available: brave");
  expect(warning?.message).toContain('configured plugin "brave" is unavailable');
});

it("warns for unknown provider ids with stale plugin config", () => {
  const res = validateWebSearchConfig(searchConfig("missing-third-party", {}));
  expect(res.ok).toBe(true);
  expect(res.warnings).toContainEqual(
    expect.objectContaining({
      path: "tools.web.search.provider",
      message: expect.stringContaining("unknown web_search provider: missing-third-party"),
    }),
  );
});
