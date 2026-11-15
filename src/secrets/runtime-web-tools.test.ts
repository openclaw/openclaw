/** Tests web-tool secret metadata resolution from config and plugins. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
} from "../plugins/types.js";
import type { BundledExplicitWebProviderParams } from "../plugins/web-provider-public-artifacts.explicit.js";
import { listSecretResolutionErrorOwners } from "./runtime-degraded-state.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshotState,
} from "./runtime-state.js";
import {
  buildTestWebFetchProviders,
  buildTestWebSearchProviders,
  createTestProvider,
  createWebCredentialEntry,
  ensureRecord,
  providerPluginId,
  type ProviderUnderTest,
} from "./runtime-web-tools-provider.test-support.js";

const { fallbackSearch } = vi.hoisted(() => ({
  fallbackSearch: vi.fn(() => buildTestWebSearchProviders()),
}));

const { fallbackFetch } = vi.hoisted(() => ({
  fallbackFetch: vi.fn(() => buildTestWebFetchProviders()),
}));
const { explicitSearch, explicitFetch } = vi.hoisted(() => ({
  explicitSearch: vi.fn<
    typeof import("../plugins/web-provider-public-artifacts.explicit.js").resolveBundledExplicitWebSearchProvidersFromPublicArtifacts
  >(() => buildTestWebSearchProviders()),
  explicitFetch: vi.fn<
    typeof import("../plugins/web-provider-public-artifacts.explicit.js").resolveBundledExplicitWebFetchProvidersFromPublicArtifacts
  >(() => buildTestWebFetchProviders()),
}));
const { bundledSearch, bundledFetch } = vi.hoisted(() => ({
  bundledSearch: vi.fn(() => buildTestWebSearchProviders()),
  bundledFetch: vi.fn(() => buildTestWebFetchProviders()),
}));
const { manifestIds, manifestOwner, defaultManifestOwner } = vi.hoisted(() => {
  const owners: Record<string, string | undefined> = {
    brave: "brave",
    firecrawl: "firecrawl",
    gemini: "google",
    grok: "xai",
    kimi: "moonshot",
    perplexity: "perplexity",
  };
  const resolveOwner = ({ value }: { value: string }) => owners[value];
  return {
    manifestIds: vi.fn(() => ["brave", "duckduckgo", "google", "moonshot", "perplexity", "xai"]),
    manifestOwner: vi.fn(resolveOwner),
    defaultManifestOwner: resolveOwner,
  };
});
const { installedPlugins } = vi.hoisted(() => ({
  installedPlugins: vi.fn(() => ({})),
}));
let secretResolve: typeof import("./resolve.js");
let createResolverContext: typeof import("./runtime-shared.js").createResolverContext;
let resolveRuntimeWebTools: typeof import("./runtime-web-tools.js").resolveRuntimeWebTools;
let restoreResolveSecretRefValuesSpy: (() => void) | undefined;

// mock-isolation: Fixed providers avoid loading the installed plugin runtime.
vi.mock("./runtime-web-tools-fallback.runtime.js", () => ({
  runtimeWebToolsFallbackProviders: {
    resolvePluginWebSearchProviders: fallbackSearch,
    resolvePluginWebFetchProviders: fallbackFetch,
  },
}));

// mock-isolation: Explicit artifact discovery uses synthetic provider metadata only.
vi.mock("../plugins/web-provider-public-artifacts.explicit.js", () => ({
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts: explicitSearch,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts: explicitFetch,
}));

vi.mock("../plugins/web-provider-public-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/web-provider-public-artifacts.js")>()),
  resolveBundledWebSearchProvidersFromPublicArtifacts: bundledSearch,
  resolveBundledWebFetchProvidersFromPublicArtifacts: bundledFetch,
}));

vi.mock("../plugins/plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-registry.js")>()),
  resolveManifestContractPluginIds: manifestIds,
  resolveManifestContractOwnerPluginId: manifestOwner,
}));

// mock-isolation: Installed-plugin records come from the fixture, not host state.
vi.mock("../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecordsSync: installedPlugins,
}));

function envRef(id: string) {
  return { source: "env", provider: "default", id };
}

function webTool(surface: "search" | "fetch", options: Record<string, unknown>) {
  return { tools: { web: { [surface]: options } } };
}

function pluginEntries(entries: Record<string, unknown>) {
  return { plugins: { entries } };
}

function firecrawlConfig(apiKey: unknown, fetch?: Record<string, unknown>): OpenClawConfig {
  return asConfig({
    ...pluginEntries({ firecrawl: createWebCredentialEntry("webFetch", apiKey) }),
    ...(fetch ? webTool("fetch", fetch) : {}),
  });
}

function readFetchKey(config: OpenClawConfig): unknown {
  return (
    config.plugins?.entries?.firecrawl?.config as { webFetch?: { apiKey?: unknown } } | undefined
  )?.webFetch?.apiKey;
}

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

async function runRuntimeWebTools(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: Parameters<typeof createResolverContext>[0]["manifestRegistry"];
  allowUnavailableSecretOwners?: boolean;
}) {
  const sourceConfig = structuredClone(params.config);
  const resolvedConfig = structuredClone(params.config);
  const context = createResolverContext({
    sourceConfig,
    env: params.env ?? {},
    manifestRegistry: params.manifestRegistry,
  });
  const result = await resolveRuntimeWebTools({
    sourceConfig,
    resolvedConfig,
    context,
    allowUnavailableSecretOwners: params.allowUnavailableSecretOwners,
  });
  return { ...result, resolvedConfig, context };
}

function activateRuntimeWebToolsResult(
  sourceConfig: OpenClawConfig,
  result: Awaited<ReturnType<typeof runRuntimeWebTools>>,
): void {
  activateSecretsRuntimeSnapshotState({
    snapshot: {
      sourceConfig,
      config: result.resolvedConfig,
      authStores: [],
      authStoreCredentialsRevision: 0,
      authStoreSnapshotsRevision: 0,
      warnings: result.context.warnings,
      degradedOwners: result.degradedOwners,
      secretOwners: result.secretOwners,
      webTools: result.metadata,
    },
    refreshContext: null,
    refreshHandler: null,
  });
}

function createProviderSecretRefConfig(
  provider: ProviderUnderTest,
  envRefId: string,
): OpenClawConfig {
  return asConfig({
    ...webTool("search", { enabled: true, provider }),
    ...pluginEntries({
      [providerPluginId(provider)]: createWebCredentialEntry("webSearch", envRef(envRefId), {
        enabled: true,
      }),
    }),
  });
}

function readProviderKey(config: OpenClawConfig, provider: ProviderUnderTest): unknown {
  const pluginConfig = config.plugins?.entries?.[providerPluginId(provider)]?.config as
    | { webSearch?: { apiKey?: unknown } }
    | undefined;
  return pluginConfig?.webSearch?.apiKey;
}

function expectDiagnostic(value: unknown, fields: { code: string; path: string }) {
  expect(value).toEqual(expect.arrayContaining([expect.objectContaining(fields)]));
}

function explicitArtifactCalls(
  source: { mock: { calls: [BundledExplicitWebProviderParams][] } },
  fixtureEnv: NodeJS.ProcessEnv = {},
) {
  // Assertion failures must never print credentials inherited from process.env.
  return source.mock.calls.map(([params]) => ({
    onlyPluginIds: params.onlyPluginIds,
    env: Object.fromEntries(Object.keys(fixtureEnv).map((key) => [key, params.env?.[key]])),
    manifestRecords: params.manifestRecords,
  }));
}

describe("runtime web tools resolution", () => {
  beforeAll(async () => {
    secretResolve = await import("./resolve.js");
    ({ createResolverContext } = await import("./runtime-shared.js"));
    ({ resolveRuntimeWebTools } = await import("./runtime-web-tools.js"));
    // The managed-index branch lazily loads this stable runtime once per process.
    await import("./runtime-web-tools-fallback.runtime.js");
  });

  beforeEach(() => {
    fallbackSearch.mockReset().mockImplementation(buildTestWebSearchProviders);
    fallbackFetch.mockClear();
    explicitSearch.mockClear();
    explicitFetch.mockClear();
    bundledSearch.mockClear();
    bundledFetch.mockClear();
    manifestOwner.mockReset().mockImplementation(defaultManifestOwner);
    manifestIds.mockClear();
    installedPlugins.mockReset().mockReturnValue({});
  });

  afterEach(() => {
    restoreResolveSecretRefValuesSpy?.();
    restoreResolveSecretRefValuesSpy = undefined;
    clearSecretsRuntimeSnapshotState();
  });

  it("keeps web search inactive when only web fetch is configured", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: firecrawlConfig(envRef("FIRECRAWL_API_KEY"), { provider: "firecrawl" }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-runtime-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.selectedProvider).toBeUndefined();
    expect(metadata.search.providerSource).toBe("none");
    expect(metadata.fetch).toMatchObject({
      selectedProvider: "firecrawl",
      selectedProviderKeySource: "secretRef",
    });
    expect(explicitSearch).not.toHaveBeenCalled();
    expect(bundledSearch).not.toHaveBeenCalled();
    expect(fallbackSearch).not.toHaveBeenCalled();
  });

  it("skips fetch provider discovery when web fetch only configures runtime limits", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        ...webTool("fetch", { enabled: true, maxChars: 200_000, maxCharsCap: 2_000_000 }),
        plugins: { enabled: true, allow: [], entries: {} },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-key-should-not-resolve", // pragma: allowlist secret
      },
    });

    expect(metadata.fetch.providerSource).toBe("none");
    expect(metadata.fetch.selectedProvider).toBeUndefined();
    expect(explicitFetch).not.toHaveBeenCalled();
    expect(bundledFetch).not.toHaveBeenCalled();
    expect(fallbackFetch).not.toHaveBeenCalled();
  });

  it("keeps active fetch provider SecretRefs on the discovery path", async () => {
    const manifestRegistry = {
      plugins: [
        createPluginManifestRecordFixture({
          id: "firecrawl",
          contracts: { webFetchProviders: ["firecrawl"] },
        }),
      ],
    };
    const { metadata, context } = await runRuntimeWebTools({
      manifestRegistry,
      config: firecrawlConfig(envRef("FIRECRAWL_API_KEY"), { provider: "firecrawl" }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-key", // pragma: allowlist secret
      },
    });

    expect(metadata.fetch).toMatchObject({
      providerSource: "configured",
      selectedProvider: "firecrawl",
    });
    expect(explicitArtifactCalls(explicitFetch, context.env)).toContainEqual({
      onlyPluginIds: ["firecrawl"],
      env: context.env,
      manifestRecords: manifestRegistry.plugins,
    });
  });

  it("does not auto-select a keyless provider when no credentials are configured", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({ ...webTool("search", { enabled: true }) }),
    });

    expect(metadata.search.selectedProvider).toBeUndefined();
    expect(metadata.search.providerSource).toBe("none");
    expect(metadata.search.diagnostics).toEqual([]);
  });

  it("resolves configured provider SecretRef and metadata for perplexity", async () => {
    const provider = "perplexity";
    const envRefId = "PERPLEXITY_PROVIDER_REF";
    const resolvedKey = "pplx-provider-key";
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: createProviderSecretRefConfig(provider, envRefId),
      env: {
        [envRefId]: resolvedKey,
      },
    });

    expect(metadata.search).toMatchObject({
      providerConfigured: provider,
      providerSource: "configured",
      selectedProvider: provider,
      selectedProviderKeySource: "secretRef",
    });
    expect(readProviderKey(resolvedConfig, provider)).toBe(resolvedKey);
    expect(context.warnings.map((warning) => warning.code)).not.toContain(
      "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
    );
    expect(metadata.search.perplexityTransport).toBe("search_api");
  });

  it("retains a stale web credential across repeated failed refreshes", async () => {
    const sourceConfig = createProviderSecretRefConfig("brave", "BRAVE_PROVIDER_REF");
    const active = await runRuntimeWebTools({
      config: sourceConfig,
      env: { BRAVE_PROVIDER_REF: "brave-last-known-good" },
    });
    activateRuntimeWebToolsResult(sourceConfig, active);

    const firstFailure = await runRuntimeWebTools({
      config: sourceConfig,
      allowUnavailableSecretOwners: true,
    });
    expect(readProviderKey(firstFailure.resolvedConfig, "brave")).toBe("brave-last-known-good");
    expect(firstFailure.degradedOwners).toMatchObject([
      { ownerId: "web-search:brave", degradationState: "stale" },
    ]);
    expect(firstFailure.secretOwners).toContainEqual(
      expect.objectContaining({
        ownerId: "web-search:brave",
        resolvedValues: [
          { refKey: "env:default:BRAVE_PROVIDER_REF", value: "brave-last-known-good" },
        ],
      }),
    );
    activateRuntimeWebToolsResult(sourceConfig, firstFailure);

    const secondFailure = await runRuntimeWebTools({
      config: sourceConfig,
      allowUnavailableSecretOwners: true,
    });
    expect(readProviderKey(secondFailure.resolvedConfig, "brave")).toBe("brave-last-known-good");
    expect(secondFailure.degradedOwners).toMatchObject([
      { ownerId: "web-search:brave", degradationState: "stale" },
    ]);
  });

  it("retains a stale web credential for a plugin id containing a dot", async () => {
    const pluginId = "external.search";
    const dottedProvider: PluginWebSearchProviderEntry = {
      ...createTestProvider({ provider: "brave", pluginId, order: 10 }),
      id: "dotted",
    };
    fallbackSearch.mockReturnValue([dottedProvider]);
    installedPlugins.mockReturnValue({
      [pluginId]: { source: "npm", spec: "@openclaw/external-search" },
    });
    manifestOwner.mockReturnValue(undefined);
    const sourceConfig = asConfig({
      tools: { web: { search: { enabled: true, provider: "dotted" } } },
      ...pluginEntries({
        [pluginId]: createWebCredentialEntry("webSearch", envRef("DOTTED_PROVIDER_REF")),
      }),
    });
    const readDottedKey = (config: OpenClawConfig) =>
      (
        config.plugins?.entries?.[pluginId]?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined
      )?.webSearch?.apiKey;
    const active = await runRuntimeWebTools({
      config: sourceConfig,
      env: { DOTTED_PROVIDER_REF: "dotted-last-known-good" },
    });
    activateRuntimeWebToolsResult(sourceConfig, active);

    const failed = await runRuntimeWebTools({
      config: sourceConfig,
      allowUnavailableSecretOwners: true,
    });

    expect(readDottedKey(failed.resolvedConfig)).toBe("dotted-last-known-good");
    expect(failed.degradedOwners).toMatchObject([
      { ownerId: "web-search:dotted", degradationState: "stale" },
    ]);
  });

  it("resolves fetch credentials through required external-provider accessors", async () => {
    const pluginId = "external.fetch";
    const provider: PluginWebFetchProviderEntry = {
      pluginId,
      id: "external-fetch",
      label: "External Fetch",
      hint: "external fetch provider",
      envVars: ["EXTERNAL_FETCH_API_KEY"],
      placeholder: "external-...",
      signupUrl: "https://example.com/fetch",
      credentialPath: "tools.web.fetch.external.apiKey",
      getCredentialValue: (fetchConfig) =>
        (fetchConfig?.external as { apiKey?: unknown } | undefined)?.apiKey,
      setCredentialValue: (fetchConfigTarget, value) => {
        ensureRecord(fetchConfigTarget, "external").apiKey = value;
      },
      createTool: () => null,
    };
    fallbackFetch.mockReturnValueOnce([provider]);
    installedPlugins.mockReturnValue({
      [pluginId]: { source: "npm", spec: "@openclaw/external-fetch" },
    });
    manifestOwner.mockImplementation(({ value, origin }: { value: string; origin?: string }) =>
      value === "external-fetch" && origin !== "bundled" ? pluginId : undefined,
    );

    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              enabled: true,
              provider: "external-fetch",
              external: { apiKey: envRef("EXTERNAL_FETCH_API_KEY") },
            },
          },
        },
      }),
      env: { EXTERNAL_FETCH_API_KEY: "test-token-placeholder" },
    });

    expect(metadata.fetch).toMatchObject({
      selectedProvider: "external-fetch",
      selectedProviderKeySource: "secretRef",
    });
    expect(
      (resolvedConfig.tools?.web?.fetch as { external?: { apiKey?: unknown } } | undefined)
        ?.external?.apiKey,
    ).toBe("test-token-placeholder");
    expect(fallbackFetch).toHaveBeenNthCalledWith(1, expect.objectContaining({ sandboxed: true }));
  });

  it("does not reuse a web credential after its plugin routing config changes", async () => {
    const pluginId = "external.search";
    const provider: PluginWebSearchProviderEntry = {
      ...createTestProvider({ provider: "brave", pluginId, order: 10 }),
      id: "external",
    };
    fallbackSearch.mockReturnValue([provider]);
    installedPlugins.mockReturnValue({
      [pluginId]: { source: "npm", spec: "@openclaw/external-search" },
    });
    manifestOwner.mockReturnValue(undefined);
    const config = (baseUrl: string) =>
      asConfig({
        tools: { web: { search: { enabled: true, provider: "external" } } },
        ...pluginEntries({
          [pluginId]: { config: { webSearch: { baseUrl, apiKey: envRef("EXTERNAL_SEARCH_REF") } } },
        }),
      });
    const activeConfig = config("https://old.example.invalid/v1");
    const active = await runRuntimeWebTools({
      config: activeConfig,
      env: { EXTERNAL_SEARCH_REF: "web-last-known-good" },
    });
    activateRuntimeWebToolsResult(activeConfig, active);

    const failed = await runRuntimeWebTools({
      config: config("https://new.example.invalid/v1"),
      allowUnavailableSecretOwners: true,
    });

    expect(failed.degradedOwners).toMatchObject([
      { ownerId: "web-search:external", degradationState: "cold" },
    ]);
  });

  it("auto-detects the next provider when a higher-priority ref is unresolved", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        ...webTool("search", { enabled: true }),
        ...pluginEntries({
          brave: createWebCredentialEntry("webSearch", envRef("MISSING_BRAVE_API_KEY_REF"), {
            enabled: true,
          }),
          google: createWebCredentialEntry("webSearch", envRef("GEMINI_API_KEY_REF"), {
            enabled: true,
          }),
        }),
      }),
      env: {
        GEMINI_API_KEY_REF: "gemini-runtime-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search).toMatchObject({
      providerSource: "auto-detect",
      selectedProvider: "gemini",
    });
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("gemini-runtime-key");
    expectDiagnostic(context.warnings, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "plugins.entries.brave.config.webSearch.apiKey",
    });
    expect(context.warnings.map((warning) => warning.code)).not.toContain(
      "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
    );
  });

  it("isolates unresolved auto-detected providers during cold start", async () => {
    const { metadata, degradedOwners } = await runRuntimeWebTools({
      config: asConfig({
        ...webTool("search", { enabled: true }),
        ...pluginEntries({
          google: createWebCredentialEntry("webSearch", envRef("MISSING_GEMINI_API_KEY_REF"), {
            enabled: true,
          }),
        }),
      }),
      allowUnavailableSecretOwners: true,
    });

    expect(metadata.search.selectedProvider).toBeUndefined();
    expect(degradedOwners).toMatchObject([
      {
        ownerKind: "capability",
        ownerId: "web-search:gemini",
        reason: "secret reference was not found",
      },
    ]);
  });

  it("auto-detects Gemini from the Google model provider key after env fallbacks", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        ...webTool("search", { enabled: true }),
        models: { providers: { google: { apiKey: "google-provider-runtime-key" } } },
      }),
    });

    expect(metadata.search).toMatchObject({
      providerSource: "auto-detect",
      selectedProvider: "gemini",
      selectedProviderKeySource: "config",
    });
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("google-provider-runtime-key");
  });

  it("does not mirror provider env fallback over configured fallback SecretRefs", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        ...webTool("search", { enabled: true }),
        models: { providers: { google: { apiKey: envRef("GOOGLE_PROVIDER_REF") } } },
      }),
      env: {
        GEMINI_API_KEY: "gemini-env-runtime-key",
        GOOGLE_PROVIDER_REF: "google-provider-ref-key",
      },
    });

    expect(metadata.search).toMatchObject({
      providerSource: "auto-detect",
      selectedProvider: "gemini",
      selectedProviderKeySource: "env",
    });
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("gemini-env-runtime-key");
    expect(resolvedConfig.models?.providers?.google?.apiKey).toBe("google-provider-ref-key");
  });

  it("keeps an invalid provider unselected without resolving another provider", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        ...webTool("search", { provider: "invalid-provider" }),
        ...pluginEntries({
          google: createWebCredentialEntry("webSearch", envRef("GEMINI_API_KEY_REF"), {
            enabled: true,
          }),
        }),
      }),
      env: {
        GEMINI_API_KEY_REF: "gemini-runtime-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.providerConfigured).toBeUndefined();
    expect(metadata.search.providerSource).toBe("none");
    expect(metadata.search.selectedProvider).toBeUndefined();
    expect(readProviderKey(resolvedConfig, "gemini")).toEqual(envRef("GEMINI_API_KEY_REF"));
    expectDiagnostic(metadata.search.diagnostics, {
      code: "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT",
      path: "tools.web.search.provider",
    });
    expectDiagnostic(context.warnings, {
      code: "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT",
      path: "tools.web.search.provider",
    });
  });

  it("fails fast when configured provider ref is unresolved with no fallback", async () => {
    const sourceConfig = asConfig({
      ...webTool("search", { provider: "gemini" }),
      ...pluginEntries({
        google: createWebCredentialEntry("webSearch", envRef("MISSING_GEMINI_API_KEY_REF"), {
          enabled: true,
        }),
      }),
    });
    const resolvedConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {},
    });

    await expect(
      resolveRuntimeWebTools({
        sourceConfig,
        resolvedConfig,
        context,
      }),
    ).rejects.toThrow("[WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK]");
    expectDiagnostic(context.warnings, {
      code: "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
      path: "plugins.entries.google.config.webSearch.apiKey",
    });
  });

  it("does not resolve web fetch provider SecretRef when web fetch is inactive", async () => {
    const resolveSpy = vi.spyOn(secretResolve, "resolveSecretRefValues");
    restoreResolveSecretRefValuesSpy = () => resolveSpy.mockRestore();
    const { metadata, context } = await runRuntimeWebTools({
      config: firecrawlConfig(envRef("MISSING_FIRECRAWL_REF"), {
        enabled: false,
        provider: "firecrawl",
      }),
    });

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(metadata.fetch.selectedProvider).toBeUndefined();
    expect(metadata.fetch.selectedProviderKeySource).toBeUndefined();
    expect(context.warnings).toStrictEqual([]);
    expect(explicitFetch).not.toHaveBeenCalled();
    expect(bundledFetch).not.toHaveBeenCalled();
    expect(fallbackFetch).not.toHaveBeenCalled();
  });

  it("skips provider discovery when no web surfaces are configured", async () => {
    const { metadata } = await runRuntimeWebTools({ config: asConfig({}) });

    expect(metadata.search.providerSource).toBe("none");
    expect(metadata.fetch.providerSource).toBe("none");
    expect(fallbackSearch).not.toHaveBeenCalled();
    expect(fallbackFetch).not.toHaveBeenCalled();
  });

  it("isolates an explicit web fetch provider when its ref is unavailable", async () => {
    const { metadata, resolvedConfig, context, degradedOwners } = await runRuntimeWebTools({
      config: asConfig({
        secrets: {
          providers: { default: { source: "file", path: "/missing/firecrawl-secrets.json" } },
        },
        ...pluginEntries({
          firecrawl: createWebCredentialEntry("webFetch", {
            source: "file",
            provider: "default",
            id: "/firecrawl/apiKey",
          }),
        }),
        ...webTool("fetch", { provider: "firecrawl" }),
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-fallback-key", // pragma: allowlist secret
      },
      allowUnavailableSecretOwners: true,
    });

    expect(metadata.fetch.providerConfigured).toBe("firecrawl");
    expect(metadata.fetch.selectedProvider).toBeUndefined();
    expect(metadata.fetch.selectedProviderKeySource).toBeUndefined();
    expect(readFetchKey(resolvedConfig)).toEqual({
      source: "file",
      provider: "default",
      id: "/firecrawl/apiKey",
    });
    expect(degradedOwners).toContainEqual(
      expect.objectContaining({
        ownerKind: "capability",
        ownerId: "web-fetch:firecrawl",
        state: "unavailable",
        paths: ["plugins.entries.firecrawl.config.webFetch.apiKey"],
        reason: "secret provider failed",
      }),
    );
    expect(degradedOwners[0]?.refKeys).toEqual(["file:default:/firecrawl/apiKey"]);
    expect(degradedOwners[0]?.reason).not.toContain("/missing/firecrawl-secrets.json");
    expectDiagnostic(context.warnings, {
      code: "SECRETS_OWNER_UNAVAILABLE",
      path: "plugins.entries.firecrawl.config.webFetch.apiKey",
    });
  });

  it("fails fast on an invalid resolved value without exposing its ref", async () => {
    const refId = "FIRECRAWL_API_KEY";
    const resolveSpy = vi
      .spyOn(secretResolve, "resolveSecretRefValues")
      .mockResolvedValue(new Map([[`env:default:${refId}`, { value: "fixture-api-key" }]]));
    restoreResolveSecretRefValuesSpy = () => resolveSpy.mockRestore();

    const error = await runRuntimeWebTools({
      config: firecrawlConfig(envRef(refId), { provider: "firecrawl" }),
      allowUnavailableSecretOwners: true,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toBe(
      "plugins.entries.firecrawl.config.webFetch.apiKey resolved to a non-string or empty value.",
    );
    expect(message).not.toContain(refId);
    expect(message).not.toContain("fixture-api-key");
    expect(listSecretResolutionErrorOwners(error)).toEqual([
      expect.objectContaining({
        ownerKind: "capability",
        ownerId: "web-fetch:firecrawl",
        reason: "resolved secret value was invalid",
        degradationState: "cold",
        failureMatched: true,
        source: "config",
      }),
    ]);
  });

  it("rejects denied providers instead of restoring stale web credentials", async () => {
    const refId = "FIRECRAWL_API_KEY";
    const error = await runRuntimeWebTools({
      config: asConfig({
        secrets: { providers: { default: { source: "env", allowlist: ["OTHER_API_KEY"] } } },
        ...pluginEntries({ firecrawl: createWebCredentialEntry("webFetch", envRef(refId)) }),
        tools: { web: { fetch: { provider: "firecrawl" } } },
      }),
      env: { [refId]: "fixture-api-key" },
      allowUnavailableSecretOwners: true,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(listSecretResolutionErrorOwners(error)).toEqual([
      expect.objectContaining({
        ownerKind: "capability",
        ownerId: "web-fetch:firecrawl",
        reason: "secret provider policy denied resolution",
        failureMatched: true,
      }),
    ]);
    expect(String(error)).not.toContain("fixture-api-key");
  });

  it("resolves providerless web fetch fallback refs with provider env var allowlist", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        ...pluginEntries({
          firecrawl: createWebCredentialEntry("webSearch", {
            source: "env",
            id: "FIRECRAWL_API_KEY",
          }),
        }),
        ...webTool("fetch", { provider: "firecrawl" }),
      }),
      env: { FIRECRAWL_API_KEY: "firecrawl-search-ref-key" },
    });

    expect(metadata.fetch).toMatchObject({
      selectedProvider: "firecrawl",
      selectedProviderKeySource: "env",
    });
    expect(readFetchKey(resolvedConfig)).toBe("firecrawl-search-ref-key");
  });

  it("resolves plugin-owned web fetch SecretRefs without tools.web.fetch", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: firecrawlConfig(envRef("FIRECRAWL_API_KEY")),
      env: { FIRECRAWL_API_KEY: "firecrawl-runtime-key" },
    });

    expect(metadata.fetch).toMatchObject({
      providerSource: "auto-detect",
      selectedProvider: "firecrawl",
      selectedProviderKeySource: "secretRef",
    });
    expect(readFetchKey(resolvedConfig)).toBe("firecrawl-runtime-key");
  });

  it("rejects env SecretRefs for web fetch provider keys outside provider allowlists", async () => {
    const sourceConfig = firecrawlConfig(envRef("AWS_SECRET_ACCESS_KEY"), {
      provider: "firecrawl",
    });
    const resolvedConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: { AWS_SECRET_ACCESS_KEY: "not-allowed" },
    });

    await expect(
      resolveRuntimeWebTools({
        sourceConfig,
        resolvedConfig,
        context,
        allowUnavailableSecretOwners: true,
      }),
    ).rejects.toThrow(
      "plugins.entries.firecrawl.config.webFetch.apiKey SecretRef is not allowed for this provider.",
    );
    expect(context.warnings).toEqual([]);
  });

  it("keeps web fetch provider discovery bundled-only during runtime secret resolution", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          load: { paths: ["/tmp/malicious-plugin"] },
          entries: {
            firecrawl: createWebCredentialEntry("webFetch", "firecrawl-config-key", {
              enabled: true,
            }),
          },
        },
        ...webTool("fetch", { provider: "firecrawl" }),
      }),
    });

    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(explicitArtifactCalls(explicitFetch)).toContainEqual({
      onlyPluginIds: ["firecrawl"],
      env: {},
      manifestRecords: undefined,
    });
    expect(bundledFetch).not.toHaveBeenCalled();
    expect(fallbackFetch).not.toHaveBeenCalled();
  });
});
