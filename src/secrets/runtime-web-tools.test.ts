/** Tests web-tool secret metadata resolution from config and plugins. */
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
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
  ensureRecord,
  providerPluginId,
  type ProviderUnderTest,
} from "./runtime-web-tools-provider.test-support.js";

const { resolvePluginWebSearchProvidersMock } = vi.hoisted(() => ({
  resolvePluginWebSearchProvidersMock: vi.fn(() => buildTestWebSearchProviders()),
}));

const { resolvePluginWebFetchProvidersMock } = vi.hoisted(() => ({
  resolvePluginWebFetchProvidersMock: vi.fn(() => buildTestWebFetchProviders()),
}));
const {
  resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock,
} = vi.hoisted(() => ({
  resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock: vi.fn<
    typeof import("../plugins/web-provider-public-artifacts.explicit.js").resolveBundledExplicitWebSearchProvidersFromPublicArtifacts
  >(() => buildTestWebSearchProviders()),
  resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock: vi.fn<
    typeof import("../plugins/web-provider-public-artifacts.explicit.js").resolveBundledExplicitWebFetchProvidersFromPublicArtifacts
  >(() => buildTestWebFetchProviders()),
}));
const {
  resolveBundledWebSearchProvidersFromPublicArtifactsMock,
  resolveBundledWebFetchProvidersFromPublicArtifactsMock,
} = vi.hoisted(() => ({
  resolveBundledWebSearchProvidersFromPublicArtifactsMock: vi.fn(() =>
    buildTestWebSearchProviders(),
  ),
  resolveBundledWebFetchProvidersFromPublicArtifactsMock: vi.fn(() => buildTestWebFetchProviders()),
}));
const { resolveManifestContractPluginIdsMock, resolveManifestContractOwnerPluginIdMock } =
  vi.hoisted(() => ({
    resolveManifestContractPluginIdsMock: vi.fn(() => [
      "brave",
      "duckduckgo",
      "google",
      "moonshot",
      "perplexity",
      "xai",
    ]),
    resolveManifestContractOwnerPluginIdMock: vi.fn(
      ({ value }: { value: string }) =>
        (
          ({
            brave: "brave",
            firecrawl: "firecrawl",
            gemini: "google",
            grok: "xai",
            kimi: "moonshot",
            perplexity: "perplexity",
          }) as Record<string, string | undefined>
        )[value],
    ),
  }));
const { loadInstalledPluginIndexInstallRecordsSyncMock } = vi.hoisted(() => ({
  loadInstalledPluginIndexInstallRecordsSyncMock: vi.fn(() => ({})),
}));
let secretResolve: typeof import("./resolve.js");
let createResolverContext: typeof import("./runtime-shared.js").createResolverContext;
let resolveRuntimeWebTools: typeof import("./runtime-web-tools.js").resolveRuntimeWebTools;
let restoreResolveSecretRefValuesSpy: (() => void) | undefined;

vi.mock("./runtime-web-tools-fallback.runtime.js", () => ({
  runtimeWebToolsFallbackProviders: {
    resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
    resolvePluginWebFetchProviders: resolvePluginWebFetchProvidersMock,
  },
}));

vi.mock("../plugins/web-provider-public-artifacts.explicit.js", () => ({
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts:
    resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts:
    resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock,
}));

vi.mock("./runtime-web-tools-public-artifacts.runtime.js", () => ({
  resolveBundledWebSearchProvidersFromPublicArtifacts:
    resolveBundledWebSearchProvidersFromPublicArtifactsMock,
  resolveBundledWebFetchProvidersFromPublicArtifacts:
    resolveBundledWebFetchProvidersFromPublicArtifactsMock,
}));

vi.mock("./runtime-web-tools-manifest.runtime.js", () => ({
  resolveManifestContractPluginIds: resolveManifestContractPluginIdsMock,
  resolveManifestContractOwnerPluginId: resolveManifestContractOwnerPluginIdMock,
}));

vi.mock("../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecordsSync: loadInstalledPluginIndexInstallRecordsSyncMock,
}));

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

function createWebCredentialEntry(
  surface: "webSearch" | "webFetch",
  apiKey: unknown,
  options: { enabled?: boolean } = {},
) {
  return {
    ...options,
    config: { [surface]: { apiKey } },
  };
}

function createProviderSecretRefConfig(
  provider: ProviderUnderTest,
  envRefId: string,
): OpenClawConfig {
  return asConfig({
    tools: {
      web: {
        search: {
          enabled: true,
          provider,
        },
      },
    },
    plugins: {
      entries: {
        [providerPluginId(provider)]: createWebCredentialEntry(
          "webSearch",
          { source: "env", provider: "default", id: envRefId },
          { enabled: true },
        ),
      },
    },
  });
}

function readProviderKey(config: OpenClawConfig, provider: ProviderUnderTest): unknown {
  const pluginConfig = config.plugins?.entries?.[providerPluginId(provider)]?.config as
    | { webSearch?: { apiKey?: unknown } }
    | undefined;
  return pluginConfig?.webSearch?.apiKey;
}

const requireRecord = createRequireRecord("object", "expected-label");

function diagnostics(value: unknown) {
  expect(Array.isArray(value), "diagnostics").toBe(true);
  return value as Array<Record<string, unknown>>;
}

function expectDiagnostic(
  value: unknown,
  fields: { code: string; path?: string; messageIncludes?: string },
) {
  const diagnostic = diagnostics(value).find(
    (candidate) =>
      candidate.code === fields.code &&
      (fields.path === undefined || candidate.path === fields.path),
  );
  if (!diagnostic) {
    throw new Error(`Expected diagnostic ${fields.code}${fields.path ? ` ${fields.path}` : ""}`);
  }
  if (fields.messageIncludes) {
    expect(typeof diagnostic.message).toBe("string");
    expect(diagnostic.message).toContain(fields.messageIncludes);
  }
}

function expectNoDiagnosticCode(value: unknown, code: string) {
  expect(diagnostics(value).some((diagnostic) => diagnostic.code === code)).toBe(false);
}

function firstMockArg(source: { mock: { calls: Array<Array<unknown>> } }) {
  const call = source.mock.calls[0];
  if (!call) {
    throw new Error("expected mock call options");
  }
  return requireRecord(call[0], "mock call options");
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
    resolvePluginWebSearchProvidersMock.mockReset();
    resolvePluginWebSearchProvidersMock.mockImplementation(() => buildTestWebSearchProviders());
    resolvePluginWebFetchProvidersMock.mockClear();
    resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock.mockClear();
    resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock.mockClear();
    resolveBundledWebSearchProvidersFromPublicArtifactsMock.mockClear();
    resolveBundledWebFetchProvidersFromPublicArtifactsMock.mockClear();
    resolveManifestContractOwnerPluginIdMock.mockReset();
    resolveManifestContractOwnerPluginIdMock.mockImplementation(
      ({ value }: { value: string }) =>
        (
          ({
            brave: "brave",
            firecrawl: "firecrawl",
            gemini: "google",
            grok: "xai",
            kimi: "moonshot",
            perplexity: "perplexity",
          }) as Record<string, string | undefined>
        )[value],
    );
    resolveManifestContractPluginIdsMock.mockClear();
    loadInstalledPluginIndexInstallRecordsSyncMock.mockReset();
    loadInstalledPluginIndexInstallRecordsSyncMock.mockReturnValue({});
  });

  afterEach(() => {
    restoreResolveSecretRefValuesSpy?.();
    restoreResolveSecretRefValuesSpy = undefined;
    clearSecretsRuntimeSnapshotState();
  });

  it("keeps web search inactive when only web fetch is configured", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            firecrawl: createWebCredentialEntry("webFetch", {
              source: "env",
              provider: "default",
              id: "FIRECRAWL_API_KEY",
            }),
          },
        },
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-runtime-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.selectedProvider).toBeUndefined();
    expect(metadata.search.providerSource).toBe("none");
    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(metadata.fetch.selectedProviderKeySource).toBe("secretRef");
    expect(resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolveBundledWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("keeps web fetch inactive when only web search is configured", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            xai: createWebCredentialEntry("webSearch", {
              source: "env",
              provider: "default",
              id: "XAI_API_KEY_REF",
            }),
          },
        },
        tools: {
          web: {
            search: {
              provider: "grok",
            },
          },
        },
      }),
      env: {
        XAI_API_KEY_REF: "xai-runtime-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.selectedProvider).toBe("grok");
    expect(metadata.search.selectedProviderKeySource).toBe("secretRef");
    expect(metadata.fetch.selectedProvider).toBeUndefined();
    expect(metadata.fetch.providerSource).toBe("none");
    expect(resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolveBundledWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  it("skips fetch provider discovery when web fetch only configures runtime limits", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              enabled: true,
              maxChars: 200_000,
              maxCharsCap: 2_000_000,
            },
          },
        },
        plugins: {
          enabled: true,
          allow: [],
          entries: {},
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-key-should-not-resolve", // pragma: allowlist secret
      },
    });

    expect(metadata.fetch.providerSource).toBe("none");
    expect(metadata.fetch.selectedProvider).toBeUndefined();
    expect(resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolveBundledWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  it("skips fetch provider discovery when web fetch is explicitly disabled", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              enabled: false,
              provider: "firecrawl",
            },
          },
        },
        plugins: {
          entries: {
            firecrawl: createWebCredentialEntry("webFetch", {
              source: "env",
              provider: "default",
              id: "FIRECRAWL_API_KEY",
            }),
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-key-should-not-resolve", // pragma: allowlist secret
      },
    });

    expect(metadata.fetch.providerSource).toBe("none");
    expect(metadata.fetch.selectedProvider).toBeUndefined();
    expect(resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolveBundledWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
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
      config: asConfig({
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
        plugins: {
          entries: {
            firecrawl: createWebCredentialEntry("webFetch", {
              source: "env",
              provider: "default",
              id: "FIRECRAWL_API_KEY",
            }),
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-key", // pragma: allowlist secret
      },
    });

    expect(metadata.fetch.providerSource).toBe("configured");
    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(
      explicitArtifactCalls(
        resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock,
        context.env,
      ),
    ).toContainEqual({
      onlyPluginIds: ["firecrawl"],
      env: context.env,
      manifestRecords: manifestRegistry.plugins,
    });
  });

  it("selects the configured keyless Firecrawl fetch provider without an API key", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      }),
    });

    expect(metadata.fetch.providerSource).toBe("configured");
    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(metadata.fetch.selectedProviderKeySource).toBe("missing");
  });

  it("does not auto-select keyless Firecrawl fetch without a credential", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              enabled: true,
            },
          },
        },
      }),
    });

    expect(metadata.fetch.providerSource).toBe("none");
    expect(metadata.fetch.selectedProvider).toBeUndefined();
  });

  it("does not auto-select a keyless provider when no credentials are configured", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
      }),
    });

    expect(metadata.search.selectedProvider).toBeUndefined();
    expect(metadata.search.providerSource).toBe("none");
    expect(metadata.search.diagnostics).toEqual([]);
  });

  it.each([
    {
      provider: "brave" as const,
      envRefId: "BRAVE_PROVIDER_REF",
      resolvedKey: "brave-provider-key",
    },
    {
      provider: "gemini" as const,
      envRefId: "GEMINI_PROVIDER_REF",
      resolvedKey: "gemini-provider-key",
    },
    {
      provider: "grok" as const,
      envRefId: "GROK_PROVIDER_REF",
      resolvedKey: "grok-provider-key",
    },
    {
      provider: "kimi" as const,
      envRefId: "KIMI_PROVIDER_REF",
      resolvedKey: "kimi-provider-key",
    },
    {
      provider: "perplexity" as const,
      envRefId: "PERPLEXITY_PROVIDER_REF",
      resolvedKey: "pplx-provider-key",
    },
  ])(
    "resolves configured provider SecretRef for $provider",
    async ({ provider, envRefId, resolvedKey }) => {
      const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
        config: createProviderSecretRefConfig(provider, envRefId),
        env: {
          [envRefId]: resolvedKey,
        },
      });

      expect(metadata.search.providerConfigured).toBe(provider);
      expect(metadata.search.providerSource).toBe("configured");
      expect(metadata.search.selectedProvider).toBe(provider);
      expect(metadata.search.selectedProviderKeySource).toBe("secretRef");
      expect(readProviderKey(resolvedConfig, provider)).toBe(resolvedKey);
      expect(context.warnings.map((warning) => warning.code)).not.toContain(
        "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
      );
      if (provider === "perplexity") {
        expect(metadata.search.perplexityTransport).toBe("search_api");
      }
    },
  );

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
    resolvePluginWebSearchProvidersMock.mockReturnValue([dottedProvider]);
    loadInstalledPluginIndexInstallRecordsSyncMock.mockReturnValue({
      [pluginId]: { source: "npm", spec: "@openclaw/external-search" },
    });
    resolveManifestContractOwnerPluginIdMock.mockReturnValue(undefined);
    const sourceConfig = asConfig({
      tools: { web: { search: { enabled: true, provider: "dotted" } } },
      plugins: {
        entries: {
          [pluginId]: createWebCredentialEntry("webSearch", {
            source: "env",
            provider: "default",
            id: "DOTTED_PROVIDER_REF",
          }),
        },
      },
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

  it("resolves search credentials through required external-provider accessors", async () => {
    const pluginId = "external.search";
    const provider: PluginWebSearchProviderEntry = {
      pluginId,
      id: "external",
      label: "External",
      hint: "external provider",
      envVars: ["EXTERNAL_SEARCH_API_KEY"],
      placeholder: "external-...",
      signupUrl: "https://example.com/search",
      credentialPath: "tools.web.search.external.apiKey",
      getCredentialValue: (searchConfig) =>
        (searchConfig?.external as { apiKey?: unknown } | undefined)?.apiKey,
      setCredentialValue: (searchConfigTarget, value) => {
        ensureRecord(searchConfigTarget, "external").apiKey = value;
      },
      createTool: () => null,
    };
    resolvePluginWebSearchProvidersMock.mockReturnValue([provider]);
    loadInstalledPluginIndexInstallRecordsSyncMock.mockReturnValue({
      [pluginId]: { source: "npm", spec: "@openclaw/external-search" },
    });
    resolveManifestContractOwnerPluginIdMock.mockImplementation(
      ({ value, origin }: { value: string; origin?: string }) =>
        value === "external" && origin !== "bundled" ? pluginId : undefined,
    );

    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "external",
              external: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "EXTERNAL_SEARCH_API_KEY",
                },
              },
            },
          },
        },
      }),
      env: { EXTERNAL_SEARCH_API_KEY: "test-token-placeholder" },
    });

    expect(metadata.search.selectedProvider).toBe("external");
    expect(metadata.search.selectedProviderKeySource).toBe("secretRef");
    expect(
      (resolvedConfig.tools?.web?.search as { external?: { apiKey?: unknown } } | undefined)
        ?.external?.apiKey,
    ).toBe("test-token-placeholder");
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
    resolvePluginWebFetchProvidersMock.mockReturnValueOnce([provider]);
    loadInstalledPluginIndexInstallRecordsSyncMock.mockReturnValue({
      [pluginId]: { source: "npm", spec: "@openclaw/external-fetch" },
    });
    resolveManifestContractOwnerPluginIdMock.mockImplementation(
      ({ value, origin }: { value: string; origin?: string }) =>
        value === "external-fetch" && origin !== "bundled" ? pluginId : undefined,
    );

    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              enabled: true,
              provider: "external-fetch",
              external: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "EXTERNAL_FETCH_API_KEY",
                },
              },
            },
          },
        },
      }),
      env: { EXTERNAL_FETCH_API_KEY: "test-token-placeholder" },
    });

    expect(metadata.fetch.selectedProvider).toBe("external-fetch");
    expect(metadata.fetch.selectedProviderKeySource).toBe("secretRef");
    expect(
      (resolvedConfig.tools?.web?.fetch as { external?: { apiKey?: unknown } } | undefined)
        ?.external?.apiKey,
    ).toBe("test-token-placeholder");
  });

  it("does not reuse a web credential after its plugin routing config changes", async () => {
    const pluginId = "external.search";
    const provider: PluginWebSearchProviderEntry = {
      ...createTestProvider({ provider: "brave", pluginId, order: 10 }),
      id: "external",
    };
    resolvePluginWebSearchProvidersMock.mockReturnValue([provider]);
    loadInstalledPluginIndexInstallRecordsSyncMock.mockReturnValue({
      [pluginId]: { source: "npm", spec: "@openclaw/external-search" },
    });
    resolveManifestContractOwnerPluginIdMock.mockReturnValue(undefined);
    const config = (baseUrl: string) =>
      asConfig({
        tools: { web: { search: { enabled: true, provider: "external" } } },
        plugins: {
          entries: {
            [pluginId]: {
              config: {
                webSearch: {
                  baseUrl,
                  apiKey: { source: "env", provider: "default", id: "EXTERNAL_SEARCH_REF" },
                },
              },
            },
          },
        },
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

  it("resolves selected provider SecretRef even when provider config is disabled", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "gemini",
            },
          },
        },
        plugins: {
          entries: {
            google: {
              enabled: true,
              config: {
                webSearch: {
                  enabled: false,
                  apiKey: {
                    source: "env",
                    provider: "default",
                    id: "WEB_SEARCH_GEMINI_API_KEY",
                  },
                },
              },
            },
          },
        },
      }),
      env: {
        WEB_SEARCH_GEMINI_API_KEY: "web-search-gemini-ref",
      },
    });

    expect(metadata.search.providerConfigured).toBe("gemini");
    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("web-search-gemini-ref");
    expect(context.warnings.map((warning) => warning.path)).not.toContain(
      "plugins.entries.google.config.webSearch.apiKey",
    );
  });

  it("auto-detects provider precedence across all configured providers", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        plugins: {
          entries: {
            brave: {
              enabled: true,
              config: {
                webSearch: { apiKey: { source: "env", provider: "default", id: "BRAVE_REF" } },
              },
            },
            google: {
              enabled: true,
              config: {
                webSearch: { apiKey: { source: "env", provider: "default", id: "GEMINI_REF" } },
              },
            },
            xai: {
              enabled: true,
              config: {
                webSearch: { apiKey: { source: "env", provider: "default", id: "GROK_REF" } },
              },
            },
            moonshot: {
              enabled: true,
              config: {
                webSearch: { apiKey: { source: "env", provider: "default", id: "KIMI_REF" } },
              },
            },
            perplexity: {
              enabled: true,
              config: {
                webSearch: { apiKey: { source: "env", provider: "default", id: "PERPLEXITY_REF" } },
              },
            },
          },
        },
      }),
      env: {
        BRAVE_REF: "brave-precedence-key",
        GEMINI_REF: "gemini-precedence-key",
        GROK_REF: "grok-precedence-key",
        KIMI_REF: "kimi-precedence-key",
        PERPLEXITY_REF: "pplx-precedence-key",
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("brave");
    expect(readProviderKey(resolvedConfig, "brave")).toBe("brave-precedence-key");
    expectDiagnostic(context.warnings, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "plugins.entries.google.config.webSearch.apiKey",
    });
    expectDiagnostic(context.warnings, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "plugins.entries.xai.config.webSearch.apiKey",
    });
    expectDiagnostic(context.warnings, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "plugins.entries.moonshot.config.webSearch.apiKey",
    });
    expectDiagnostic(context.warnings, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "plugins.entries.perplexity.config.webSearch.apiKey",
    });
  });

  it("auto-detects first available provider and keeps lower-priority refs inactive", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        plugins: {
          entries: {
            brave: createWebCredentialEntry(
              "webSearch",
              { source: "env", provider: "default", id: "BRAVE_API_KEY_REF" },
              { enabled: true },
            ),
            google: createWebCredentialEntry(
              "webSearch",
              { source: "env", provider: "default", id: "MISSING_GEMINI_API_KEY_REF" },
              { enabled: true },
            ),
          },
        },
      }),
      env: {
        BRAVE_API_KEY_REF: "brave-runtime-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("brave");
    expect(metadata.search.selectedProviderKeySource).toBe("secretRef");
    expect(readProviderKey(resolvedConfig, "brave")).toBe("brave-runtime-key");
    expect(readProviderKey(resolvedConfig, "gemini")).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_GEMINI_API_KEY_REF",
    });
    expectDiagnostic(context.warnings, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "plugins.entries.google.config.webSearch.apiKey",
    });
    expect(context.warnings.map((warning) => warning.code)).not.toContain(
      "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
    );
  });

  it("auto-detects the next provider when a higher-priority ref is unresolved", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        plugins: {
          entries: {
            brave: createWebCredentialEntry(
              "webSearch",
              { source: "env", provider: "default", id: "MISSING_BRAVE_API_KEY_REF" },
              { enabled: true },
            ),
            google: createWebCredentialEntry(
              "webSearch",
              { source: "env", provider: "default", id: "GEMINI_API_KEY_REF" },
              { enabled: true },
            ),
          },
        },
      }),
      env: {
        GEMINI_API_KEY_REF: "gemini-runtime-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("gemini");
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
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        plugins: {
          entries: {
            google: createWebCredentialEntry(
              "webSearch",
              {
                source: "env",
                provider: "default",
                id: "MISSING_GEMINI_API_KEY_REF",
              },
              { enabled: true },
            ),
          },
        },
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
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        models: {
          providers: {
            google: {
              apiKey: "google-provider-runtime-key",
            },
          },
        },
      }),
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(metadata.search.selectedProviderKeySource).toBe("config");
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("google-provider-runtime-key");
  });

  it("prefers GEMINI_API_KEY over the Google model provider key", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        models: {
          providers: {
            google: {
              apiKey: "google-provider-runtime-key",
            },
          },
        },
      }),
      env: {
        GEMINI_API_KEY: "gemini-env-runtime-key",
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(metadata.search.selectedProviderKeySource).toBe("env");
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("gemini-env-runtime-key");
  });

  it("does not mirror provider env fallback over configured fallback SecretRefs", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        models: {
          providers: {
            google: {
              apiKey: { source: "env", provider: "default", id: "GOOGLE_PROVIDER_REF" },
            },
          },
        },
      }),
      env: {
        GEMINI_API_KEY: "gemini-env-runtime-key",
        GOOGLE_PROVIDER_REF: "google-provider-ref-key",
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(metadata.search.selectedProviderKeySource).toBe("env");
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("gemini-env-runtime-key");
    expect(resolvedConfig.models?.providers?.google?.apiKey).toBe("google-provider-ref-key");
  });

  it("keeps an invalid provider unselected without resolving another provider", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              provider: "invalid-provider",
            },
          },
        },
        plugins: {
          entries: {
            google: createWebCredentialEntry(
              "webSearch",
              { source: "env", provider: "default", id: "GEMINI_API_KEY_REF" },
              { enabled: true },
            ),
          },
        },
      }),
      env: {
        GEMINI_API_KEY_REF: "gemini-runtime-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.providerConfigured).toBeUndefined();
    expect(metadata.search.providerSource).toBe("none");
    expect(metadata.search.selectedProvider).toBeUndefined();
    expect(readProviderKey(resolvedConfig, "gemini")).toEqual({
      source: "env",
      provider: "default",
      id: "GEMINI_API_KEY_REF",
    });
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
      tools: {
        web: {
          search: {
            provider: "gemini",
          },
        },
      },
      plugins: {
        entries: {
          google: createWebCredentialEntry(
            "webSearch",
            { source: "env", provider: "default", id: "MISSING_GEMINI_API_KEY_REF" },
            { enabled: true },
          ),
        },
      },
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

  it("uses bundled-only runtime provider resolution for configured bundled providers", async () => {
    const manifestRegistry = {
      plugins: [
        createPluginManifestRecordFixture({
          id: "google",
          contracts: { webSearchProviders: ["gemini"] },
        }),
      ],
    };
    const { metadata, context } = await runRuntimeWebTools({
      manifestRegistry,
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "gemini",
            },
          },
        },
        plugins: {
          entries: {
            google: createWebCredentialEntry(
              "webSearch",
              { source: "env", provider: "default", id: "GEMINI_PROVIDER_REF" },
              { enabled: true },
            ),
          },
        },
      }),
      env: {
        GEMINI_PROVIDER_REF: "gemini-provider-key",
      },
    });

    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(
      explicitArtifactCalls(
        resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock,
        context.env,
      ),
    ).toContainEqual({
      onlyPluginIds: ["google"],
      env: context.env,
      manifestRecords: manifestRegistry.plugins,
    });
    expect(resolveManifestContractOwnerPluginIdMock).not.toHaveBeenCalled();
    expect(resolveBundledWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("uses exact plugin-id hints for configured bundled provider entries without manifest owner lookup", async () => {
    const { metadata, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "brave",
            },
          },
        },
        plugins: {
          entries: {
            brave: createWebCredentialEntry(
              "webSearch",
              { source: "env", provider: "default", id: "BRAVE_PROVIDER_REF" },
              { enabled: true },
            ),
            google: createWebCredentialEntry(
              "webSearch",
              { source: "env", provider: "default", id: "GOOGLE_PROVIDER_REF" },
              { enabled: true },
            ),
          },
        },
      }),
      env: {
        BRAVE_PROVIDER_REF: "brave-provider-key",
        GOOGLE_PROVIDER_REF: "google-provider-key",
      },
    });

    expect(metadata.search.selectedProvider).toBe("brave");
    expect(
      explicitArtifactCalls(
        resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock,
        context.env,
      ),
    ).toContainEqual({
      onlyPluginIds: ["brave"],
      env: context.env,
      manifestRecords: undefined,
    });
    expect(resolveManifestContractOwnerPluginIdMock).not.toHaveBeenCalled();
    expect(resolveBundledWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("uses single plugin-scoped web search config as a bundled provider hint", async () => {
    const { metadata, context } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            google: createWebCredentialEntry(
              "webSearch",
              { source: "env", provider: "default", id: "GOOGLE_PROVIDER_REF" },
              { enabled: true },
            ),
          },
        },
      }),
      env: {
        GOOGLE_PROVIDER_REF: "google-provider-key",
      },
    });

    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(
      explicitArtifactCalls(
        resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock,
        context.env,
      ),
    ).toContainEqual({
      onlyPluginIds: ["google"],
      env: context.env,
      manifestRecords: undefined,
    });
    expect(resolveManifestContractOwnerPluginIdMock).not.toHaveBeenCalled();
    expect(resolveBundledWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("does not resolve web fetch provider SecretRef when web fetch is inactive", async () => {
    const resolveSpy = vi.spyOn(secretResolve, "resolveSecretRefValues");
    restoreResolveSecretRefValuesSpy = () => resolveSpy.mockRestore();
    const { metadata, context } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            firecrawl: createWebCredentialEntry("webFetch", {
              source: "env",
              provider: "default",
              id: "MISSING_FIRECRAWL_REF",
            }),
          },
        },
        tools: {
          web: {
            fetch: {
              enabled: false,
              provider: "firecrawl",
            },
          },
        },
      }),
    });

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(metadata.fetch.selectedProvider).toBeUndefined();
    expect(metadata.fetch.selectedProviderKeySource).toBeUndefined();
    expect(context.warnings).toStrictEqual([]);
    expect(resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolveBundledWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  it("keeps configured provider metadata and inactive warnings when search is disabled", async () => {
    const { metadata, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: false,
              provider: "gemini",
            },
          },
        },
        plugins: {
          entries: {
            google: createWebCredentialEntry(
              "webSearch",
              { source: "env", provider: "default", id: "GEMINI_PROVIDER_REF" },
              { enabled: true },
            ),
          },
        },
      }),
    });

    expect(metadata.search.providerConfigured).toBe("gemini");
    expect(metadata.search.providerSource).toBe("configured");
    expectDiagnostic(context.warnings, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "plugins.entries.google.config.webSearch.apiKey",
    });
  });

  it("emits inactive warnings for configured and lower-priority web-search providers when search is disabled", async () => {
    const { context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: false,
            },
          },
        },
        plugins: {
          entries: {
            google: createWebCredentialEntry("webSearch", {
              source: "env",
              provider: "default",
              id: "DISABLED_WEB_SEARCH_GEMINI_API_KEY",
            }),
          },
        },
      }),
    });

    expectDiagnostic(context.warnings, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "plugins.entries.google.config.webSearch.apiKey",
    });
  });

  it("does not auto-enable search when tools.web.search is absent", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({}),
    });

    expect(metadata.search.providerSource).toBe("none");
    expect(metadata.search.selectedProvider).toBeUndefined();
  });

  it("skips provider discovery when no web surfaces are configured", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({}),
    });

    expect(metadata.search.providerSource).toBe("none");
    expect(metadata.fetch.providerSource).toBe("none");
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  it("uses bundled public artifacts for bundled web search provider discovery", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              provider: "brave",
            },
          },
        },
      }),
      env: {
        BRAVE_API_KEY: "brave-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.selectedProvider).toBe("brave");
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("uses runtime web search discovery when the managed plugin index install records is populated", async () => {
    loadInstalledPluginIndexInstallRecordsSyncMock.mockReturnValue({
      "external-search": {
        source: "npm",
        spec: "@openclaw/external-search",
      },
    });

    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
      }),
      env: {
        BRAVE_API_KEY: "brave-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.selectedProvider).toBe("brave");
    expect(resolveBundledWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(firstMockArg(resolvePluginWebSearchProvidersMock).config).toBeDefined();
  });

  it("uses bundled public artifacts for bundled web fetch provider discovery", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-key", // pragma: allowlist secret
      },
    });

    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  it("resolves SecretRefs for verified installed Firecrawl fetch config", async () => {
    loadInstalledPluginIndexInstallRecordsSyncMock.mockReturnValue({
      firecrawl: {
        source: "npm",
        spec: "@openclaw/firecrawl-plugin",
      },
    });
    resolveManifestContractOwnerPluginIdMock.mockReturnValueOnce(undefined);

    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
        plugins: {
          entries: {
            firecrawl: createWebCredentialEntry("webFetch", {
              source: "env",
              provider: "default",
              id: "FIRECRAWL_API_KEY",
            }),
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-config-key",
      },
    });

    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(metadata.fetch.selectedProviderKeySource).toBe("secretRef");
    expect(
      (
        resolvedConfig.plugins?.entries?.firecrawl?.config as
          | { webFetch?: { apiKey?: unknown } }
          | undefined
      )?.webFetch?.apiKey,
    ).toBe("firecrawl-config-key");
    expect(resolveBundledWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(firstMockArg(resolvePluginWebFetchProvidersMock).sandboxed).toBe(true);
  });

  it("isolates an explicit web fetch provider when its ref is unavailable", async () => {
    const { metadata, resolvedConfig, context, degradedOwners } = await runRuntimeWebTools({
      config: asConfig({
        secrets: {
          providers: {
            default: { source: "file", path: "/missing/firecrawl-secrets.json" },
          },
        },
        plugins: {
          entries: {
            firecrawl: createWebCredentialEntry("webFetch", {
              source: "file",
              provider: "default",
              id: "/firecrawl/apiKey",
            }),
          },
        },
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-fallback-key", // pragma: allowlist secret
      },
      allowUnavailableSecretOwners: true,
    });

    expect(metadata.fetch.providerConfigured).toBe("firecrawl");
    expect(metadata.fetch.selectedProvider).toBeUndefined();
    expect(metadata.fetch.selectedProviderKeySource).toBeUndefined();
    expect(
      (
        resolvedConfig.plugins?.entries?.firecrawl?.config as
          | { webFetch?: { apiKey?: unknown } }
          | undefined
      )?.webFetch?.apiKey,
    ).toEqual({ source: "file", provider: "default", id: "/firecrawl/apiKey" });
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
      config: asConfig({
        plugins: {
          entries: {
            firecrawl: createWebCredentialEntry("webFetch", {
              source: "env",
              provider: "default",
              id: refId,
            }),
          },
        },
        tools: { web: { fetch: { provider: "firecrawl" } } },
      }),
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
        secrets: {
          providers: {
            default: { source: "env", allowlist: ["OTHER_API_KEY"] },
          },
        },
        plugins: {
          entries: {
            firecrawl: createWebCredentialEntry("webFetch", {
              source: "env",
              provider: "default",
              id: refId,
            }),
          },
        },
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

  it("resolves web fetch fallback SecretRefs with provider env var allowlist", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            firecrawl: createWebCredentialEntry("webSearch", {
              source: "env",
              provider: "default",
              id: "FIRECRAWL_API_KEY",
            }),
          },
        },
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-search-ref-key",
      },
    });

    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(metadata.fetch.selectedProviderKeySource).toBe("env");
    expect(
      (
        resolvedConfig.plugins?.entries?.firecrawl?.config as
          | { webFetch?: { apiKey?: unknown } }
          | undefined
      )?.webFetch?.apiKey,
    ).toBe("firecrawl-search-ref-key");
  });

  it("resolves plugin-owned web fetch SecretRefs without tools.web.fetch", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            firecrawl: createWebCredentialEntry("webFetch", {
              source: "env",
              provider: "default",
              id: "FIRECRAWL_API_KEY",
            }),
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-runtime-key",
      },
    });

    expect(metadata.fetch.providerSource).toBe("auto-detect");
    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(metadata.fetch.selectedProviderKeySource).toBe("secretRef");
    expect(
      (
        resolvedConfig.plugins?.entries?.firecrawl?.config as
          | { webFetch?: { apiKey?: unknown } }
          | undefined
      )?.webFetch?.apiKey,
    ).toBe("firecrawl-runtime-key");
  });

  it("fails fast when active web fetch provider SecretRef is unresolved with no fallback", async () => {
    const sourceConfig = asConfig({
      plugins: {
        entries: {
          firecrawl: createWebCredentialEntry("webFetch", {
            source: "env",
            provider: "default",
            id: "FIRECRAWL_API_KEY",
          }),
        },
      },
      tools: {
        web: {
          fetch: {
            provider: "firecrawl",
          },
        },
      },
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
    ).rejects.toThrow("[WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK]");
    expectDiagnostic(context.warnings, {
      code: "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK",
      path: "plugins.entries.firecrawl.config.webFetch.apiKey",
    });
  });

  it("rejects env SecretRefs for web fetch provider keys outside provider allowlists", async () => {
    const sourceConfig = asConfig({
      plugins: {
        entries: {
          firecrawl: createWebCredentialEntry("webFetch", {
            source: "env",
            provider: "default",
            id: "AWS_SECRET_ACCESS_KEY",
          }),
        },
      },
      tools: {
        web: {
          fetch: {
            provider: "firecrawl",
          },
        },
      },
    });
    const resolvedConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {
        AWS_SECRET_ACCESS_KEY: "not-allowed",
      },
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
          load: {
            paths: ["/tmp/malicious-plugin"],
          },
          entries: {
            firecrawl: createWebCredentialEntry("webFetch", "firecrawl-config-key", {
              enabled: true,
            }),
          },
        },
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      }),
    });

    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(
      explicitArtifactCalls(resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock),
    ).toContainEqual({
      onlyPluginIds: ["firecrawl"],
      env: {},
      manifestRecords: undefined,
    });
    expect(resolveBundledWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  describe("when brave is installed as an external plugin and explicitly configured", () => {
    const externalBraveImpl = ({
      value,
      origin,
    }: {
      value: string;
      origin?: string;
    }): string | undefined => {
      if (origin === "bundled" && value === "brave") {
        return undefined;
      }
      return (
        {
          brave: "brave",
          firecrawl: "firecrawl",
          gemini: "google",
          grok: "xai",
          kimi: "moonshot",
          perplexity: "perplexity",
        } as Record<string, string | undefined>
      )[value];
    };

    const defaultImpl = ({ value }: { value: string }): string | undefined =>
      (
        ({
          brave: "brave",
          firecrawl: "firecrawl",
          gemini: "google",
          grok: "xai",
          kimi: "moonshot",
          perplexity: "perplexity",
        }) as Record<string, string | undefined>
      )[value];

    beforeEach(() => {
      loadInstalledPluginIndexInstallRecordsSyncMock.mockReturnValue({
        brave: { source: "npm", spec: "@openclaw/brave-search" },
      });
      resolveManifestContractOwnerPluginIdMock.mockImplementation(externalBraveImpl);
    });

    afterEach(() => {
      resolveManifestContractOwnerPluginIdMock.mockImplementation(defaultImpl);
    });

    it("selects the configured provider without re-invoking provider discovery when found in the first pass", async () => {
      resolvePluginWebSearchProvidersMock
        .mockReturnValueOnce(buildTestWebSearchProviders())
        .mockReturnValueOnce([]);

      const { metadata, context } = await runRuntimeWebTools({
        config: asConfig({
          tools: {
            web: {
              search: {
                provider: "brave",
              },
            },
          },
          plugins: {
            entries: {
              brave: createWebCredentialEntry(
                "webSearch",
                "brave-api-key", // pragma: allowlist secret
              ),
            },
          },
        }),
      });

      expect(metadata.search.selectedProvider).toBe("brave");
      expect(metadata.search.providerSource).toBe("configured");
      expect(metadata.search.selectedProviderKeySource).toBe("config");
      expectNoDiagnosticCode(context.warnings, "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT");
      expect(resolvePluginWebSearchProvidersMock).toHaveBeenCalledTimes(1);
      expect(
        resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock,
      ).not.toHaveBeenCalled();
      expect(resolveBundledWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
