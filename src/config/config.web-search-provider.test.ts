import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import { createWebSearchTestProvider } from "../test-utils/web-provider-runtime.test-helpers.js";
import { resolveWebSearchProviderId } from "../web-search/runtime.js";
import { buildWebSearchProviderConfig } from "./test-helpers.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn() },
}));

vi.mock("../plugins/manifest-registry.js", () => {
  const providers = [
    ["brave", "brave"],
    ["firecrawl", "firecrawl"],
    ["gemini", "google"],
    ["grok", "xai"],
    ["kimi", "moonshot"],
    ["minimax", "minimax"],
    ["perplexity", "perplexity"],
    ["searxng", "searxng"],
    ["tavily", "tavily"],
  ] as const;
  const secretInput = {
    oneOf: [
      { type: "string" },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string" },
          provider: { type: "string" },
          id: { type: "string" },
        },
        required: ["source", "provider", "id"],
      },
    ],
  };
  const configSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      webSearch: {
        type: "object",
        additionalProperties: false,
        properties: { apiKey: secretInput, baseUrl: secretInput, model: { type: "string" } },
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

describe("web search provider config", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { apiKey: undefined, expected: "" },
    { apiKey: "test-brave-key", expected: "brave" }, // pragma: allowlist secret
  ])("selects '$expected' with environment credential $apiKey", ({ apiKey, expected }) => {
    vi.stubEnv("BRAVE_API_KEY", apiKey);
    const provider = createWebSearchTestProvider({
      id: "brave",
      pluginId: "brave",
      credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
    });
    expect(resolveWebSearchProviderId({ search: {}, providers: [provider] })).toBe(expected);
  });

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
    expect(
      validateWebSearchConfig({
        tools: {
          web: {
            search: {
              provider: "gemini",
              gemini: { apiKey: "legacy-key" },
            },
          },
        },
      }).ok,
    ).toBe(false);
  });

  it("accepts provider ids registered by installed plugin manifests", () => {
    expect(validateWebSearchConfig(searchConfig("acme-search")).ok).toBe(true);
  });

  it("rejects installable provider ids when the plugin is not active", () => {
    const res = validateWebSearchConfig(searchConfig("brave"), missingPlugins);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toContainEqual(
        expect.objectContaining({
          path: "tools.web.search.provider",
          message:
            'web_search provider is not available: brave (install or enable plugin "brave", then run openclaw doctor --fix)',
          allowedValues: expect.arrayContaining(["brave"]),
        }),
      );
    }
  });

  it("warns for unavailable installable providers with stale plugin config", () => {
    const res = validateWebSearchConfig(searchConfig("brave", {}), missingPlugins);
    expect(res.ok).toBe(true);
    const warning = res.warnings.find((entry) => entry.path === "tools.web.search.provider");
    expect(warning?.message).toContain("web_search provider is not available: brave");
    expect(warning?.message).toContain('configured plugin "brave" is unavailable');
  });

  it("rejects unknown provider ids without plugin evidence", () => {
    const res = validateWebSearchConfig(searchConfig("brvae"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toContainEqual(
        expect.objectContaining({
          path: "tools.web.search.provider",
          message: "unknown web_search provider: brvae",
          allowedValues: expect.arrayContaining(["acme-search", "brave", "gemini"]),
        }),
      );
    }
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
});
