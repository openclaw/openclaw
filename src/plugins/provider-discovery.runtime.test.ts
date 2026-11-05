/** Covers provider discovery runtime loading from plugin manifests and registries. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
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

import { resolvePluginDiscoveryProvidersRuntime as discoverProviders } from "./provider-discovery.runtime.js";

function createManifestPlugin(id: string, entry = true): PluginManifestRecord {
  return createPluginManifestRecordFixture({
    id,
    enabledByDefault: true,
    providers: [id],
    source: "bundled",
    providerDiscoverySource: entry ? `/tmp/${id}/provider-discovery.ts` : undefined,
  });
}

function discoverFixture(entry: ProviderPlugin | ProviderPlugin[], runtime: ProviderPlugin[]) {
  const manifest = createManifestPlugin("fixture");
  manifest.modelCatalog = { discovery: { fixture: "runtime" } };
  mockManifestPlugins([manifest]);
  mocks.loadSource.mockReturnValue(entry);
  mocks.resolvePluginProvidersCore.mockReturnValue(runtime);
  return discoverProviders({ onlyPluginIds: ["fixture"], includeSyntheticAuthProviders: true });
}

type Catalog = NonNullable<PluginManifestRecord["modelCatalog"]>;
type CatalogProvider = NonNullable<Catalog["providers"]>[string];
type CatalogModel = CatalogProvider["models"][number];
const catalogModel = (
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
  fields: Partial<CatalogModel> = {},
) => ({ id, name, input: ["text" as const], contextWindow, maxTokens, ...fields });
const anthropicModel = () =>
  catalogModel("claude-sonnet-4-6", "Claude Sonnet 4.6", 200000, 64000, { reasoning: true });
function catalogManifest(
  id: string,
  providers: Catalog["providers"],
  discovery: Catalog["discovery"],
): PluginManifestRecord {
  return {
    ...createManifestPlugin(id, false),
    modelCatalog: { providers, discovery },
  };
}

function createManifestPluginWithModelCatalog(
  id: string,
  discovery: "static" | "refreshable" | "runtime" = "static",
): PluginManifestRecord {
  return catalogManifest(id, { [id]: manifestProvider("catalog-model") }, { [id]: discovery });
}

function manifestProvider(id: string): CatalogProvider {
  return {
    baseUrl: "https://catalog.example.test/v1",
    api: "openai-responses",
    models: [
      catalogModel(id, id, 128000, 4096, {
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: "low", max: "max" },
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
      }),
    ],
  };
}

function credentialManifest(id: string, envVar: string): PluginManifestRecord {
  return {
    ...createManifestPlugin(id, false),
    setup: { providers: [{ id, envVars: [envVar] }] },
  };
}

function createProvider(id: string, mode: "static" | "catalog"): ProviderPlugin {
  const hook = {
    run: async () => ({ provider: { baseUrl: "https://example.test/v1", models: [] } }),
  };
  return {
    id,
    label: id,
    auth: [],
    ...(mode === "static" ? { staticCatalog: hook } : { catalog: hook }),
  };
}

function mockManifestPlugins(plugins: PluginManifestRecord[]) {
  mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(plugins.map(({ id }) => id));
  mocks.loadPluginMetadataSnapshot.mockReturnValue({
    index: { plugins: [] },
    manifestRegistry: { plugins, diagnostics: [] },
  });
}

const runtimePluginIds = () => mocks.resolvePluginProvidersCore.mock.calls[0]?.[0]?.onlyPluginIds;

describe("resolvePluginDiscoveryProvidersRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockManifestPlugins([createManifestPlugin("deepseek")]);
    mocks.resolvePluginMetadataSnapshot.mockImplementation(
      (params?: { pluginMetadataSnapshot?: unknown }) =>
        params?.pluginMetadataSnapshot ?? mocks.loadPluginMetadataSnapshot(params),
    );
  });

  it("retains prepared auth through attribution until the provider hook changes", async () => {
    const auth = { apiKey: "native-marker", source: "fixture", mode: "oauth" as const };
    const provider: ProviderPlugin = {
      id: "native",
      label: "Native fixture",
      auth: [],
      prepareSyntheticAuth: vi.fn(async () => auth),
    };
    mocks.loadSource.mockReturnValue(provider);
    expect(discoverProviders({ discoveryEntriesOnly: true })).toEqual([]);
    const context = { config: {}, provider: "native" };
    const options = { env: {}, workspaceDir: "/workspace" };
    const discover = () => {
      const [discovered] = discoverProviders({
        discoveryEntriesOnly: true,
        includeSyntheticAuthProviders: true,
      });
      if (!discovered) {
        throw new Error("Fixture discovery provider missing");
      }
      return discovered;
    };
    expect(discover()).toMatchObject({ id: "native", pluginId: "deepseek" });
    expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
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
    const entryProvider = createProvider("deepseek", "static");
    mocks.loadSource.mockReturnValue(entryProvider);
    mockManifestPlugins([
      createManifestPlugin("deepseek"),
      {
        ...catalogManifest(
          "xiaomi",
          {
            xiaomi: manifestProvider("mimo-v2-flash"),
            "xiaomi-token-plan": manifestProvider("mimo-v2.5-pro"),
          },
          { xiaomi: "static", "xiaomi-token-plan": "runtime" },
        ),
        providers: ["xiaomi", "xiaomi-token-plan"],
      },
    ]);

    const providers = discoverProviders({
      discoveryEntriesOnly: true,
      requireCompleteDiscoveryEntryCoverage: true,
    });

    expect(providers.map((provider) => provider.id)).toEqual(["xiaomi", "deepseek"]);
    expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
    expect(
      discoverProviders({
        discoveryEntriesOnly: true,
        includeManifestModelCatalogProviders: false,
      }).map(({ id }) => id),
    ).toEqual(["deepseek"]);
  });

  it("keeps unscoped discovery bounded for mixed live and static-only entries", () => {
    const codexEntryProvider = createProvider("codex", "catalog");
    const deepseekEntryProvider = createProvider("deepseek", "static");
    const fullProviders = [createProvider("kilocode", "catalog")];
    mockManifestPlugins([
      createManifestPlugin("codex"),
      createManifestPlugin("deepseek"),
      credentialManifest("kilocode", "KILOCODE_API_KEY"),
      credentialManifest("unused", "UNUSED_API_KEY"),
    ]);
    mocks.loadSource.mockImplementation((modulePath: string) =>
      modulePath.includes("/codex/") ? codexEntryProvider : deepseekEntryProvider,
    );
    mocks.resolvePluginProvidersCore.mockReturnValue(fullProviders);

    expect(discoverProviders({ env: { KILOCODE_API_KEY: "sk-test" } })).toMatchObject([
      { id: "codex", pluginId: "codex", pluginRoot: "/tmp/codex" },
      { id: "deepseek", pluginId: "deepseek", pluginRoot: "/tmp/deepseek" },
      { id: "kilocode" },
    ]);
    expect(runtimePluginIds()).toEqual(["kilocode"]);
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
        ...createProvider("fixture-static", "static"),
        pluginId: "fixture",
      };
      const native = createProvider("fixture-cli", "catalog");
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
      const providers = discoverFixture(
        [authProvider, native],
        emptyRuntime ? [] : [runtimeProvider, unrelatedAuth],
      );

      expect(providers.map(({ id }) => id)).toEqual(
        emptyRuntime
          ? ["fixture-cli", "fixture-login"]
          : ["fixture-cli", "fixture-login", "fixture-static"],
      );
      expect(providers[0]?.catalog).toBe(native.catalog);
      expect(providers[1]?.prepareSyntheticAuth).toBe(authProvider.prepareSyntheticAuth);
      expect(providers[1]?.staticCatalog).toBeUndefined();
      expect(unrelatedAuth.resolveSyntheticAuth).not.toHaveBeenCalled();
      if (!emptyRuntime) {
        expect(providers[2]?.staticCatalog).toBe(runtimeProvider.staticCatalog);
      }
      expect(runtimePluginIds()).toEqual(["fixture"]);
    },
  );

  it.each(["none", "sync", "async"] as const)(
    "composes lightweight auth with runtime catalog replacement (runtime auth: %s)",
    async (runtimeAuth) => {
      const entryAuth = { apiKey: "entry-key", source: "entry", mode: "api-key" as const };
      const runtimeAuthResult = { ...entryAuth, apiKey: "runtime-key", source: "runtime" };
      const entryProvider: ProviderPlugin = {
        ...createProvider("fixture", "static"),
        ...(runtimeAuth === "async"
          ? { resolveSyntheticAuth: vi.fn(() => entryAuth) }
          : { prepareSyntheticAuth: vi.fn(async () => entryAuth) }),
      };
      const runtimeProvider: ProviderPlugin = {
        ...createProvider("fixture", "static"),
        pluginId: "fixture",
        pluginRoot: "/tmp/fixture",
        ...(runtimeAuth === "sync" ? { resolveSyntheticAuth: vi.fn(() => runtimeAuthResult) } : {}),
        ...(runtimeAuth === "async"
          ? { prepareSyntheticAuth: vi.fn(async () => runtimeAuthResult) }
          : {}),
      };
      const providers = discoverFixture(entryProvider, [runtimeProvider]);

      expect(providers).toHaveLength(1);
      const provider = providers[0]!;
      expect(provider.staticCatalog).toBe(runtimeProvider.staticCatalog);
      expect(
        await prepareSyntheticAuthWithProvider(provider, { config: {}, provider: "fixture" }),
      ).toEqual(runtimeAuth === "none" ? entryAuth : runtimeAuthResult);
      if (runtimeAuth !== "none") {
        expect(
          entryProvider.prepareSyntheticAuth ?? entryProvider.resolveSyntheticAuth,
        ).not.toHaveBeenCalled();
      }
      expect(runtimePluginIds()).toEqual(["fixture"]);

      expect(discoverProviders({ onlyPluginIds: ["fixture"] })).toEqual([runtimeProvider]);
    },
  );

  it.each(["agent", "plugin"] as const)(
    "retains canonical %s credential scope in a configured static catalog descriptor",
    (scope) => {
      const provider = {
        baseUrl: "https://fixture.invalid/v1",
        api: "openai-completions" as const,
        models: [
          {
            ...catalogModel("configured", "Configured", 10000, 1000),
            input: ["text" as const],
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      };
      mockManifestPlugins([
        catalogManifest(
          "fixture",
          {
            fixture: {
              ...provider,
              authScope: scope,
              models: [catalogModel("configured", "Configured", 10000, 1000)],
            },
          },
          { fixture: "static" },
        ),
      ]);
      const providers = discoverProviders({
        discoveryEntriesOnly: true,
        config: { models: { providers: { fixture: provider } } },
      });
      expect(providers).toHaveLength(1);
      expect(providers[0]?.authScope).toBe(scope);
      expect(providers[0]?.staticCatalog).toBeDefined();
      expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing", undefined, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
    [
      "partial",
      { input: 3, output: 15, cacheRead: 0.3 },
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
    ],
  ] as const)(
    "defaults only %s manifest model cost components",
    async (_name, cost, expectedCost) => {
      mockManifestPlugins([
        catalogManifest(
          "anthropic",
          {
            "claude-cli": { models: [anthropicModel()] },
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              api: "anthropic-messages",
              models: [{ ...anthropicModel(), ...(cost ? { cost } : {}) }],
            },
          },
          { "claude-cli": "static", anthropic: "static" },
        ),
      ]);

      const providers = discoverProviders({ discoveryEntriesOnly: true });
      expect(providers.map(({ id }) => id)).toEqual(["anthropic"]);

      expect(
        await providers[0]?.staticCatalog?.run({
          config: {},
          env: {},
          resolveProviderApiKey: () => ({ apiKey: undefined }),
          resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
        }),
      ).toEqual({
        providers: {
          anthropic: expect.objectContaining({
            models: [expect.objectContaining({ id: "claude-sonnet-4-6", cost: expectedCost })],
          }),
        },
      });
    },
  );

  it.each([
    ["selected static", "static", true, false, false, ["router"]],
    ["selected runtime", "runtime", true, false, false, ["manifest", "router"]],
    ["credentialed runtime", "runtime", false, true, false, ["manifest", "router"]],
    ["uncredentialed refreshable", "refreshable", false, false, false, ["manifest"]],
    ["runtime owner without rows", "static", false, false, true, ["router"]],
  ] as const)(
    "bounds runtime loading for %s",
    (_name, discovery, selected, credential, runtimeOnly, expectedFullIds) => {
      mockManifestPlugins([
        runtimeOnly
          ? catalogManifest("router", undefined, { router: "runtime" })
          : credentialManifest("router", "ROUTER_API_KEY"),
        createManifestPluginWithModelCatalog("manifest", discovery),
      ]);
      mocks.resolvePluginProvidersCore.mockImplementation(
        ({ onlyPluginIds }: { onlyPluginIds: string[] }) =>
          onlyPluginIds.map((id) => createProvider(id, "catalog")),
      );

      const providers = discoverProviders({
        env: credential ? { ROUTER_API_KEY: "catalog-test-key" } : {},
        ...(selected ? { onlyPluginIds: ["router", "manifest"] } : {}),
      });
      expect(providers.map((provider) => provider.id)).toEqual(
        selected || credential || runtimeOnly ? ["manifest", "router"] : ["manifest"],
      );
      expect(runtimePluginIds()).toEqual(expectedFullIds);
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
      mockManifestPlugins([
        createManifestPluginWithModelCatalog("static"),
        ...(failurePosition === "first" ? [broken, healthy] : [healthy, broken]),
      ]);
      mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["static", "healthy", "broken"]);
      mocks.loadSource.mockImplementation((modulePath: string) => {
        if (modulePath === broken.providerDiscoverySource) {
          throw new Error("discovery entry unavailable");
        }
        return { ...createProvider("healthy", "catalog"), label: "entry" };
      });
      const fullProviders = expectedFullIds.map((id) => ({
        ...createProvider(id, "catalog"),
        label: `full:${id}`,
      }));
      mocks.resolvePluginProvidersCore.mockReturnValue(fullProviders);

      const providers = discoverProviders({
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
        expect(runtimePluginIds()).toEqual(expectedFullIds);
      }
    },
  );
});
