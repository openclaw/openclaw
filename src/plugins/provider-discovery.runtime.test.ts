/** Covers provider discovery runtime loading from plugin manifests and registries. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "./manifest-registry.js";
import {
  prepareSyntheticAuthWithProvider,
  resolveSyntheticAuthWithProvider,
} from "./provider-synthetic-auth.js";
import type { ProviderPlugin } from "./types.js";

const mocks = vi.hoisted(() => {
  // Bind provider discovery to this file's mocks in non-isolated plugin workers.
  vi.resetModules();
  const loadSource = vi.fn();
  const initialize = <T>(run: () => T): T => run();
  return {
    loadPluginMetadataSnapshot: vi.fn(),
    resolvePluginMetadataSnapshot: vi.fn(),
    resolveDiscoveredProviderPluginIds: vi.fn(),
    resolvePluginProvidersCore: vi.fn(),
    loadSource,
    initialize,
    getPluginSetupModuleLoader: vi.fn(() => Object.assign(loadSource, { initialize })),
  };
});

vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-metadata-snapshot.js")>();
  return {
    ...actual,
    loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
    resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
  };
});

vi.mock("./providers.js", () => ({
  resolveDiscoveredProviderPluginIds: mocks.resolveDiscoveredProviderPluginIds,
}));

vi.mock("./providers.runtime.js", () => ({
  resolvePluginProvidersCore: mocks.resolvePluginProvidersCore,
}));

vi.mock("./plugin-setup-module.js", () => ({
  getPluginSetupModuleLoader: mocks.getPluginSetupModuleLoader,
}));

import { resolvePluginDiscoveryProvidersRuntime } from "./provider-discovery.runtime.js";

function createManifestPlugin(id: string): PluginManifestRecord {
  return {
    id,
    enabledByDefault: true,
    channels: [],
    providers: [id],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: `/tmp/${id}`,
    source: "bundled",
    manifestPath: `/tmp/${id}/openclaw.plugin.json`,
    providerDiscoverySource: `/tmp/${id}/provider-discovery.ts`,
  };
}

function configureCapturedRuntimeManifest() {
  mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["fixture"]);
  const manifest = createManifestPlugin("fixture");
  manifest.modelCatalog = { discovery: { fixture: "runtime" } };
  mocks.loadPluginMetadataSnapshot.mockReturnValue({
    index: { plugins: [] },
    manifestRegistry: { plugins: [manifest], diagnostics: [] },
  });
}

function createManifestPluginWithModelCatalog(
  id: string,
  discovery: "static" | "refreshable" | "runtime" = "static",
): PluginManifestRecord {
  return {
    ...createManifestPluginWithoutDiscovery({ id }),
    modelCatalog: {
      providers: {
        [id]: {
          baseUrl: "https://catalog.example.test/v1",
          api: "openai-responses",
          models: [
            {
              id: "catalog-model",
              name: "Catalog Model",
              reasoning: true,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 4096,
              thinkingLevelMap: { off: null, minimal: "low", max: "max" },
              cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
            },
          ],
        },
      },
      discovery: { [id]: discovery },
    },
  };
}

function createManifestPluginWithMixedCatalogDiscovery(): PluginManifestRecord {
  return {
    ...createManifestPluginWithoutDiscovery({ id: "xiaomi" }),
    providers: ["xiaomi", "xiaomi-token-plan"],
    modelCatalog: {
      providers: {
        xiaomi: {
          baseUrl: "https://api.xiaomimimo.com/v1",
          api: "openai-completions",
          models: [
            {
              id: "mimo-v2-flash",
              name: "MiMo V2 Flash",
              input: ["text"],
              contextWindow: 262144,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
        "xiaomi-token-plan": {
          baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
          api: "openai-completions",
          models: [
            {
              id: "mimo-v2.5-pro",
              name: "MiMo V2.5 Pro",
              input: ["text"],
              contextWindow: 1048576,
              maxTokens: 32000,
              cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
            },
          ],
        },
      },
      discovery: {
        xiaomi: "static",
        "xiaomi-token-plan": "runtime",
      },
    },
  };
}

function createManifestPluginWithRuntimeDiscoveryOnly(id: string): PluginManifestRecord {
  return {
    ...createManifestPluginWithoutDiscovery({ id }),
    modelCatalog: {
      discovery: { [id]: "runtime" },
    },
  };
}

function createManifestPluginWithoutDiscovery(params: {
  id: string;
  setupProviders?: NonNullable<PluginManifestRecord["setup"]>["providers"];
}): PluginManifestRecord {
  const { providerDiscoverySource: _providerDiscoverySource, ...plugin } = createManifestPlugin(
    params.id,
  );
  return {
    ...plugin,
    ...(params.setupProviders ? { setup: { providers: params.setupProviders } } : {}),
  };
}

function createProvider(params: { id: string; mode: "static" | "catalog" }): ProviderPlugin {
  const hook = {
    run: async () => ({
      provider: {
        baseUrl: "https://example.test/v1",
        models: [],
      },
    }),
  };
  return {
    id: params.id,
    label: params.id,
    auth: [],
    ...(params.mode === "static" ? { staticCatalog: hook } : { catalog: hook }),
  };
}

function mockManifestPlugins(plugins: PluginManifestRecord[]) {
  mocks.loadPluginMetadataSnapshot.mockReturnValue({
    index: { plugins: [] },
    manifestRegistry: { plugins, diagnostics: [] },
  });
}

function requireResolvePluginProvidersParams(index = 0): {
  onlyPluginIds?: string[];
} {
  const params = (
    mocks.resolvePluginProvidersCore.mock.calls[index] as [unknown] | undefined
  )?.[0] as
    | {
        onlyPluginIds?: string[];
      }
    | undefined;
  if (!params) {
    throw new Error(`resolvePluginProvidersCore call ${index} missing`);
  }
  return params;
}

function requireDiscoveredProviderIdsParams(index = 0): {
  registry?: unknown;
  manifestRegistry?: unknown;
} {
  const params = (
    mocks.resolveDiscoveredProviderPluginIds.mock.calls[index] as [unknown] | undefined
  )?.[0] as
    | {
        registry?: unknown;
        manifestRegistry?: unknown;
      }
    | undefined;
  if (!params) {
    throw new Error(`resolveDiscoveredProviderPluginIds call ${index} missing`);
  }
  return params;
}

describe("resolvePluginDiscoveryProvidersRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["deepseek"]);
    mockManifestPlugins([createManifestPlugin("deepseek")]);
    mocks.resolvePluginMetadataSnapshot.mockImplementation(
      (params?: { pluginMetadataSnapshot?: unknown }) =>
        params?.pluginMetadataSnapshot ?? mocks.loadPluginMetadataSnapshot(params),
    );
  });

  it("retains prepared auth through attribution until the provider hook changes", async () => {
    const auth = { apiKey: "native-marker", source: "fixture", mode: "oauth" as const };
    const provider: ProviderPlugin = {
      id: "deepseek",
      label: "Native fixture",
      auth: [],
      prepareSyntheticAuth: vi.fn(async () => auth),
    };
    mocks.loadSource.mockReturnValue(provider);
    const context = { config: {}, provider: "deepseek" };
    const options = { env: {}, workspaceDir: "/workspace" };
    const discover = () => {
      const [discovered] = resolvePluginDiscoveryProvidersRuntime({
        discoveryEntriesOnly: true,
        includeSyntheticAuthProviders: true,
      });
      if (!discovered) {
        throw new Error("Fixture discovery provider missing");
      }
      return discovered;
    };
    await prepareSyntheticAuthWithProvider(discover(), context, options);
    expect(resolveSyntheticAuthWithProvider(discover(), context, options)).toEqual(auth);

    const replacement = { ...provider, prepareSyntheticAuth: vi.fn(async () => undefined) };
    mocks.getPluginSetupModuleLoader.mockReturnValueOnce(
      Object.assign(
        vi.fn(() => replacement),
        { initialize: mocks.initialize },
      ),
    );
    expect(resolveSyntheticAuthWithProvider(discover(), context, options)).toBeUndefined();
    expect(provider.prepareSyntheticAuth).toHaveBeenCalledOnce();
    expect(replacement.prepareSyntheticAuth).not.toHaveBeenCalled();
  });

  it("counts mixed static manifest entries for entries-only complete coverage", () => {
    const entryProvider = createProvider({ id: "deepseek", mode: "static" });
    mocks.loadSource.mockReturnValue(entryProvider);
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["deepseek", "xiaomi"]);
    mockManifestPlugins([
      createManifestPlugin("deepseek"),
      createManifestPluginWithMixedCatalogDiscovery(),
    ]);

    const providers = resolvePluginDiscoveryProvidersRuntime({
      discoveryEntriesOnly: true,
      requireCompleteDiscoveryEntryCoverage: true,
    });

    expect(providers.map((provider) => provider.id)).toEqual(["xiaomi", "deepseek"]);
    expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it("loads runtime-only catalog plugins declared without manifest rows", () => {
    const runtimeProvider = createProvider({ id: "runtime-only", mode: "catalog" });
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["deepseek", "runtime-only"]);
    mocks.resolvePluginProvidersCore.mockReturnValue([runtimeProvider]);
    mockManifestPlugins([
      createManifestPluginWithModelCatalog("deepseek"),
      createManifestPluginWithRuntimeDiscoveryOnly("runtime-only"),
    ]);

    const providers = resolvePluginDiscoveryProvidersRuntime({});

    expect(providers.map((provider) => provider.id)).toEqual(["deepseek", "runtime-only"]);
    expect(requireResolvePluginProvidersParams().onlyPluginIds).toEqual(["runtime-only"]);
  });

  it("keeps unscoped discovery bounded for mixed live and static-only entries", () => {
    const codexEntryProvider = createProvider({ id: "codex", mode: "catalog" });
    const deepseekEntryProvider = createProvider({ id: "deepseek", mode: "static" });
    const fullProviders = [createProvider({ id: "kilocode", mode: "catalog" })];
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue([
      "codex",
      "deepseek",
      "kilocode",
      "unused",
    ]);
    mockManifestPlugins([
      createManifestPlugin("codex"),
      createManifestPlugin("deepseek"),
      createManifestPluginWithoutDiscovery({
        id: "kilocode",
        setupProviders: [{ id: "kilocode", envVars: ["KILOCODE_API_KEY"] }],
      }),
      createManifestPluginWithoutDiscovery({
        id: "unused",
        setupProviders: [{ id: "unused", envVars: ["UNUSED_API_KEY"] }],
      }),
    ]);
    mocks.loadSource.mockImplementation((modulePath: string) =>
      modulePath.includes("/codex/") ? codexEntryProvider : deepseekEntryProvider,
    );
    mocks.resolvePluginProvidersCore.mockReturnValue(fullProviders);

    expect(
      resolvePluginDiscoveryProvidersRuntime({
        env: { KILOCODE_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      }),
    ).toEqual([
      { ...codexEntryProvider, pluginId: "codex", pluginRoot: "/tmp/codex" },
      { ...deepseekEntryProvider, pluginId: "deepseek", pluginRoot: "/tmp/deepseek" },
      ...fullProviders,
    ]);
    expect(mocks.resolvePluginProvidersCore).toHaveBeenCalledTimes(1);
    const params = requireResolvePluginProvidersParams();
    expect(params.onlyPluginIds).toEqual(["kilocode"]);
  });

  it("uses a provided plugin metadata snapshot without rebuilding registry metadata", () => {
    const registry = { plugins: [] };
    const manifestRegistry = {
      plugins: [createManifestPlugin("deepseek")],
      diagnostics: [],
    };
    mocks.loadSource.mockReturnValue(createProvider({ id: "deepseek", mode: "catalog" }));

    const providers = resolvePluginDiscoveryProvidersRuntime({
      config: {},
      env: {} as NodeJS.ProcessEnv,
      pluginMetadataSnapshot: {
        index: registry as never,
        manifestRegistry,
      },
    });
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe("deepseek");
    expect(providers[0]?.pluginId).toBe("deepseek");

    expect(mocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(mocks.resolveDiscoveredProviderPluginIds).toHaveBeenCalledTimes(1);
    const params = requireDiscoveredProviderIdsParams();
    expect(params.registry).toBe(registry);
    expect(params.manifestRegistry).toBe(manifestRegistry);
  });

  it("returns synthetic-auth discovery entries only when explicitly requested", () => {
    const syntheticProvider: ProviderPlugin = {
      id: "claude-cli",
      label: "Claude CLI",
      auth: [],
      resolveSyntheticAuth: () => ({
        apiKey: "synthetic-token",
        source: "test",
        mode: "oauth",
      }),
    };
    mocks.loadSource.mockReturnValue(syntheticProvider);

    expect(resolvePluginDiscoveryProvidersRuntime({ discoveryEntriesOnly: true })).toEqual([]);
    const providers = resolvePluginDiscoveryProvidersRuntime({
      discoveryEntriesOnly: true,
      includeSyntheticAuthProviders: true,
    });

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ id: "claude-cli", pluginId: "deepseek" });
    expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "retains discovery-only auth beside captured runtime siblings (empty: %s)",
    (emptyRuntime) => {
      const auth = { apiKey: "fixture-key", source: "fixture", mode: "api-key" as const };
      const authProvider: ProviderPlugin = {
        id: "fixture-login",
        label: "Fixture login",
        auth: [],
        prepareSyntheticAuth: vi.fn(async () => auth),
      };
      const runtimeProvider = {
        ...createProvider({ id: "fixture-static", mode: "static" }),
        pluginId: "fixture",
      };
      configureCapturedRuntimeManifest();
      mocks.loadSource.mockReturnValue(authProvider);
      const unrelatedAuth = {
        id: "runtime-only-login",
        pluginId: "fixture",
        label: "Runtime-only login",
        auth: [],
        resolveSyntheticAuth: vi.fn(() => ({
          ...auth,
          apiKey: "unselected-key",
          source: "runtime",
        })),
      };
      mocks.resolvePluginProvidersCore.mockReturnValue(
        emptyRuntime ? [] : [runtimeProvider, unrelatedAuth],
      );

      const providers = resolvePluginDiscoveryProvidersRuntime({
        onlyPluginIds: ["fixture"],
        includeSyntheticAuthProviders: true,
      });

      expect(providers.map(({ id }) => id)).toEqual(
        emptyRuntime ? ["fixture-login"] : ["fixture-login", "fixture-static"],
      );
      expect(providers[0]?.prepareSyntheticAuth).toBe(authProvider.prepareSyntheticAuth);
      expect(providers[0]?.staticCatalog).toBeUndefined();
      expect(unrelatedAuth.resolveSyntheticAuth).not.toHaveBeenCalled();
      expect(mocks.resolvePluginProvidersCore).toHaveBeenCalledTimes(1);
      expect(requireResolvePluginProvidersParams().onlyPluginIds).toEqual(["fixture"]);
    },
  );

  it("retains a native catalog beside a different runtime provider from the same plugin", async () => {
    configureCapturedRuntimeManifest();
    const native = createProvider({ id: "fixture-cli", mode: "catalog" });
    const hosted = { ...createProvider({ id: "fixture", mode: "catalog" }), pluginId: "fixture" };
    mocks.loadSource.mockReturnValue(native);
    mocks.resolvePluginProvidersCore.mockReturnValue([hosted]);

    const providers = resolvePluginDiscoveryProvidersRuntime({
      onlyPluginIds: ["fixture"],
      includeSyntheticAuthProviders: true,
    });

    expect(providers.map(({ id }) => id)).toEqual(["fixture-cli", "fixture"]);
    expect(providers[0]?.catalog).toBe(native.catalog);
    expect(providers[1]?.catalog).toBe(hosted.catalog);
  });
  it.each(["none", "sync", "async"] as const)(
    "composes lightweight auth with runtime catalog replacement (runtime auth: %s)",
    async (runtimeAuth) => {
      const entryAuth = { apiKey: "entry-key", source: "entry", mode: "api-key" as const };
      const runtimeAuthResult = { ...entryAuth, apiKey: "runtime-key", source: "runtime" };
      const entryProvider: ProviderPlugin = {
        ...createProvider({ id: "fixture", mode: "static" }),
        ...(runtimeAuth === "async"
          ? { resolveSyntheticAuth: vi.fn(() => entryAuth) }
          : { prepareSyntheticAuth: vi.fn(async () => entryAuth) }),
      };
      const runtimeProvider: ProviderPlugin = {
        ...createProvider({ id: "fixture", mode: "static" }),
        pluginId: "fixture",
        pluginRoot: "/tmp/fixture",
        ...(runtimeAuth === "sync" ? { resolveSyntheticAuth: vi.fn(() => runtimeAuthResult) } : {}),
        ...(runtimeAuth === "async"
          ? { prepareSyntheticAuth: vi.fn(async () => runtimeAuthResult) }
          : {}),
      };
      configureCapturedRuntimeManifest();
      mocks.loadSource.mockReturnValue(entryProvider);
      mocks.resolvePluginProvidersCore.mockReturnValue([runtimeProvider]);

      const providers = resolvePluginDiscoveryProvidersRuntime({
        onlyPluginIds: ["fixture"],
        includeSyntheticAuthProviders: true,
      });

      expect(providers).toHaveLength(1);
      const provider = providers[0]!;
      expect(provider.staticCatalog).toBe(runtimeProvider.staticCatalog);
      await expect(
        prepareSyntheticAuthWithProvider(provider, { config: {}, provider: "fixture" }),
      ).resolves.toEqual(runtimeAuth === "none" ? entryAuth : runtimeAuthResult);
      if (runtimeAuth !== "none") {
        expect(
          entryProvider.prepareSyntheticAuth ?? entryProvider.resolveSyntheticAuth,
        ).not.toHaveBeenCalled();
      }
      expect(mocks.resolvePluginProvidersCore).toHaveBeenCalledTimes(1);
      expect(requireResolvePluginProvidersParams().onlyPluginIds).toEqual(["fixture"]);

      expect(resolvePluginDiscoveryProvidersRuntime({ onlyPluginIds: ["fixture"] })).toEqual([
        runtimeProvider,
      ]);
    },
  );

  it("can omit manifest model catalogs from static discovery entries", () => {
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["openai"]);
    mockManifestPlugins([createManifestPluginWithModelCatalog("openai")]);

    const providers = resolvePluginDiscoveryProvidersRuntime({
      discoveryEntriesOnly: true,
      includeManifestModelCatalogProviders: false,
    });

    expect(providers).toStrictEqual([]);
    expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing",
      cost: undefined,
      expectedCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    {
      name: "partial",
      cost: { input: 3, output: 15, cacheRead: 0.3 },
      expectedCost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
    },
  ])("defaults only $name manifest model cost components", async ({ cost, expectedCost }) => {
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["anthropic"]);
    mockManifestPlugins([
      {
        ...createManifestPluginWithModelCatalog("anthropic"),
        modelCatalog: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              api: "anthropic-messages",
              models: [
                {
                  id: "claude-sonnet-4-6",
                  name: "Claude Sonnet 4.6",
                  reasoning: true,
                  input: ["text"],
                  contextWindow: 200000,
                  maxTokens: 64000,
                  ...(cost ? { cost } : {}),
                },
              ],
            },
          },
          discovery: { anthropic: "static" },
        },
      },
    ]);

    const providers = resolvePluginDiscoveryProvidersRuntime({ discoveryEntriesOnly: true });

    await expect(
      providers[0]?.staticCatalog?.run({
        config: {},
        env: {},
        resolveProviderApiKey: () => ({ apiKey: undefined }),
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      }),
    ).resolves.toEqual({
      providers: {
        anthropic: expect.objectContaining({
          models: [
            expect.objectContaining({
              id: "claude-sonnet-4-6",
              cost: expectedCost,
            }),
          ],
        }),
      },
    });
  });

  it("ignores manifest model catalogs that cannot form valid models.json providers", () => {
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["anthropic"]);
    mockManifestPlugins([
      {
        ...createManifestPluginWithModelCatalog("anthropic"),
        modelCatalog: {
          providers: {
            "claude-cli": {
              models: [
                {
                  id: "claude-sonnet-4-6",
                  name: "Claude Sonnet 4.6",
                  reasoning: true,
                  input: ["text"],
                  contextWindow: 200000,
                  maxTokens: 64000,
                },
              ],
            },
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              api: "anthropic-messages",
              models: [
                {
                  id: "claude-sonnet-4-6",
                  name: "Claude Sonnet 4.6",
                  reasoning: true,
                  input: ["text"],
                  contextWindow: 200000,
                  maxTokens: 64000,
                },
              ],
            },
          },
          discovery: { "claude-cli": "static", anthropic: "static" },
        },
      },
    ]);

    const providers = resolvePluginDiscoveryProvidersRuntime({ discoveryEntriesOnly: true });

    expect(providers.map((provider) => provider.id)).toEqual(["anthropic"]);
  });

  it.each(["static", "runtime"] as const)(
    "keeps scoped providers without entries beside a %s manifest catalog",
    (discovery) => {
      const dynamicProvider = createProvider({ id: "minimax", mode: "catalog" });
      mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["minimax", "openai"]);
      mockManifestPlugins([
        createManifestPluginWithoutDiscovery({ id: "minimax" }),
        createManifestPluginWithModelCatalog("openai", discovery),
      ]);
      mocks.resolvePluginProvidersCore.mockImplementation(
        ({ onlyPluginIds }: { onlyPluginIds: string[] }) =>
          [dynamicProvider, createProvider({ id: "openai", mode: "catalog" })].filter((provider) =>
            onlyPluginIds.includes(provider.id),
          ),
      );

      const providers = resolvePluginDiscoveryProvidersRuntime({
        onlyPluginIds: ["minimax", "openai"],
      });

      expect(providers.map((provider) => provider.id).toSorted()).toEqual(["minimax", "openai"]);
      expect(mocks.resolvePluginProvidersCore).toHaveBeenCalledTimes(1);
      expect(requireResolvePluginProvidersParams().onlyPluginIds).toEqual(
        discovery === "static" ? ["minimax"] : ["minimax", "openai"],
      );
    },
  );

  it.each([
    { discovery: "runtime" as const, credential: true },
    { discovery: "refreshable" as const, credential: false },
  ])(
    "bounds unscoped $discovery discovery with missing-entry credential=$credential",
    ({ discovery, credential }) => {
      mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["router", "manifest"]);
      mockManifestPlugins([
        createManifestPluginWithoutDiscovery({
          id: "router",
          setupProviders: [{ id: "router", envVars: ["ROUTER_API_KEY"] }],
        }),
        createManifestPluginWithModelCatalog("manifest", discovery),
      ]);
      mocks.resolvePluginProvidersCore.mockImplementation(
        ({ onlyPluginIds }: { onlyPluginIds: string[] }) =>
          onlyPluginIds.map((id) => createProvider({ id, mode: "catalog" })),
      );

      const providers = resolvePluginDiscoveryProvidersRuntime({
        env: credential ? { ROUTER_API_KEY: "catalog-test-key" } : {},
      });
      expect(providers.map((provider) => provider.id)).toEqual(
        credential ? ["manifest", "router"] : ["manifest"],
      );
    },
  );

  it.each(
    [
      { scope: "selected", expectedFullIds: ["broken", "healthy"] },
      { scope: "unscoped", expectedFullIds: ["healthy"] },
      { scope: "entries-only", expectedFullIds: [] },
    ].flatMap(({ scope, expectedFullIds }) =>
      (scope === "unscoped" ? ["first", "last"] : ["last"]).map((failurePosition) => ({
        scope,
        expectedFullIds,
        failurePosition,
      })),
    ),
  )(
    "recovers discarded discovery entries with $scope scope when failure is $failurePosition",
    ({ scope, expectedFullIds, failurePosition }) => {
      const healthy = {
        ...createManifestPlugin("healthy"),
        setup: { providers: [{ id: "healthy", envVars: ["HEALTHY_API_KEY"] }] },
      };
      const broken = createManifestPlugin("broken");
      mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["static", "healthy", "broken"]);
      mockManifestPlugins([
        createManifestPluginWithModelCatalog("static"),
        ...(failurePosition === "first" ? [broken, healthy] : [healthy, broken]),
      ]);
      mocks.loadSource.mockImplementation((modulePath: string) => {
        if (modulePath === broken.providerDiscoverySource) {
          throw new Error("discovery entry unavailable");
        }
        return { ...createProvider({ id: "healthy", mode: "catalog" }), label: "entry" };
      });
      const fullProviders = expectedFullIds.map((id) => ({
        ...createProvider({ id, mode: "catalog" }),
        label: `full:${id}`,
      }));
      mocks.resolvePluginProvidersCore.mockReturnValue(fullProviders);

      const providers = resolvePluginDiscoveryProvidersRuntime({
        env: { HEALTHY_API_KEY: "catalog-test-key" },
        ...(scope === "unscoped" ? {} : { onlyPluginIds: ["static", "healthy", "broken"] }),
        discoveryEntriesOnly: scope === "entries-only",
      });

      expect(providers.map(({ id, label }) => [id, label])).toEqual([
        ["static", "static"],
        ...fullProviders.map(({ id, label }) => [id, label]),
      ]);
      if (expectedFullIds.length === 0) {
        expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
      } else {
        expect(mocks.resolvePluginProvidersCore).toHaveBeenCalledOnce();
        expect(requireResolvePluginProvidersParams().onlyPluginIds).toEqual(expectedFullIds);
      }
    },
  );
});
