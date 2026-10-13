import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationRegistryScope } from "./runtime/generation-state.js";
import type { WebProviderRuntimeResolution } from "./web-provider-runtime-shared.js";

const mocks = vi.hoisted(() => ({
  loadPluginRegistryHandleAsync: vi.fn(),
  resolveCompatibleRuntimePluginRegistry: vi.fn(),
  getLoadedRuntimePluginRegistry: vi.fn(),
  resolvePluginRegistryLoadCacheKey: vi.fn((options: unknown) => JSON.stringify(options)),
  resolveRuntimePluginRegistry: vi.fn(),
  getActivePluginRegistry: vi.fn<() => Record<string, unknown> | null>(() => null),
  getActivePluginRegistryWorkspaceDir: vi.fn(() => undefined),
  buildPluginRuntimeLoadOptions: vi.fn((_values: unknown, overrides?: Record<string, unknown>) => ({
    ...overrides,
  })),
  createPluginRuntimeLoaderLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// mock-isolation: Resolution fixtures provide metadata without reading shared machine state.
vi.mock("./installed-plugin-index-record-state.js", () => ({
  preparePluginMetadataMachineStateAsync: async () => () => {},
}));

// mock-isolation: Web provider lifecycle fixtures control exact registry acquisition without loading installed plugins.
vi.mock("./loader.js", () => ({
  loadPluginRegistryHandleAsync: mocks.loadPluginRegistryHandleAsync,
  resolveCompatibleRuntimePluginRegistry: mocks.resolveCompatibleRuntimePluginRegistry,
  resolvePluginRegistryLoadCacheKey: mocks.resolvePluginRegistryLoadCacheKey,
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
}));

vi.mock("./active-runtime-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./active-runtime-registry.js")>()),
  getLoadedRuntimePluginRegistry: mocks.getLoadedRuntimePluginRegistry,
}));

vi.mock("./runtime.js", () => ({
  getActivePluginRegistry: mocks.getActivePluginRegistry,
  getActivePluginRegistryWorkspaceDir: mocks.getActivePluginRegistryWorkspaceDir,
}));

vi.mock("./runtime/load-context.js", () => ({
  buildPluginRuntimeLoadOptions: mocks.buildPluginRuntimeLoadOptions,
  createPluginRuntimeLoaderLogger: mocks.createPluginRuntimeLoaderLogger,
}));

let resolvePluginWebProvidersAsync: typeof import("./web-provider-runtime-shared.js").resolvePluginWebProvidersAsync;

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function mockArg(mock: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  return requireRecord(mock.mock.calls[callIndex]?.[0]);
}

function resolution(
  overrides: Partial<WebProviderRuntimeResolution<string>> &
    Pick<WebProviderRuntimeResolution<string>, "mapRegistryProviders">,
): WebProviderRuntimeResolution<string> {
  return {
    resolveBundledResolutionConfig: ({ manifestRecords }) => ({
      config: {},
      activationSourceConfig: {},
      autoEnabledReasons: {},
      manifestRecords,
    }),
    resolveCandidatePluginIds: () => ["brave"],
    ...overrides,
  };
}

describe("web-provider-runtime-shared", () => {
  beforeAll(async () => {
    ({ resolvePluginWebProvidersAsync } = await import("./web-provider-runtime-shared.js"));
  });

  it("rejects cold synchronous discovery without starting a native load", async () => {
    const { resolvePluginWebProviders } = await import("./web-provider-runtime-shared.js");
    expect(() =>
      resolvePluginWebProviders(
        { config: {} },
        resolution({
          mapRegistryProviders: () => [],
        }),
      ),
    ).toThrow("await async web provider resolution");
    expect(mocks.loadPluginRegistryHandleAsync).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    mocks.loadPluginRegistryHandleAsync.mockReset();
    mocks.resolveCompatibleRuntimePluginRegistry.mockReset();
    mocks.getLoadedRuntimePluginRegistry.mockReset();
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(undefined);
    mocks.resolvePluginRegistryLoadCacheKey.mockReset();
    mocks.resolvePluginRegistryLoadCacheKey.mockImplementation((options: unknown) =>
      JSON.stringify(options),
    );
    mocks.resolveRuntimePluginRegistry.mockReset();
    mocks.getActivePluginRegistry.mockReset();
    mocks.getActivePluginRegistry.mockReturnValue(null);
    mocks.getActivePluginRegistryWorkspaceDir.mockReset();
    mocks.getActivePluginRegistryWorkspaceDir.mockReturnValue(undefined);
    mocks.buildPluginRuntimeLoadOptions.mockReset();
    mocks.buildPluginRuntimeLoadOptions.mockImplementation(
      (_values: unknown, overrides?: Record<string, unknown>) => ({
        ...overrides,
      }),
    );
  });

  it("preserves explicit empty scopes in runtime-compatible web provider loads", async () => {
    const activeRegistry = { source: "active" };
    const mapRegistryProviders = vi.fn(() => []);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(activeRegistry as never);

    const result = await resolvePluginWebProvidersAsync(
      {
        config: {},
        onlyPluginIds: [],
      },
      resolution({
        resolveCandidatePluginIds: () => [],
        mapRegistryProviders,
      }),
    );

    expect(mockArg(mocks.getLoadedRuntimePluginRegistry).requiredPluginIds).toEqual([]);
    expect(mapRegistryProviders).toHaveBeenCalledWith({
      registry: activeRegistry,
      onlyPluginIds: [],
    });
    expect(result).toStrictEqual([]);
    expect(mocks.loadPluginRegistryHandleAsync).not.toHaveBeenCalled();
  });

  it("preserves explicit scopes when config is omitted in direct runtime resolution", async () => {
    const mapRegistryProviders = vi.fn(() => []);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue({} as never);

    await resolvePluginWebProvidersAsync(
      {
        onlyPluginIds: ["alpha"],
      },
      resolution({
        resolveCandidatePluginIds: () => ["alpha"],
        mapRegistryProviders,
      }),
    );

    expect(mockArg(mocks.getLoadedRuntimePluginRegistry).requiredPluginIds).toEqual(["alpha"]);
    expect(mockArg(mapRegistryProviders).onlyPluginIds).toEqual(["alpha"]);
  });

  it("resolves provider candidates from the original config and prepared manifests", async () => {
    const activeRegistry = { source: "active" };
    const config = { plugins: { entries: {} } };
    const resolvedConfig = { plugins: { entries: { brave: { enabled: true } } } };
    const manifestRecords: PluginManifestRecord[] = [];
    const resolveCandidatePluginIds = vi.fn(() => ["brave"]);
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(activeRegistry);

    const providers = await resolvePluginWebProvidersAsync(
      {
        config,
        env: { BRAVE_API_KEY: "key" },
        onlyPluginIds: ["brave", "firecrawl"],
        origin: "bundled",
        sandboxed: true,
        workspaceDir: "/workspace",
        manifestRecords,
      },
      resolution({
        resolveBundledResolutionConfig: () => ({
          config: resolvedConfig,
          activationSourceConfig: config,
          autoEnabledReasons: { brave: ["env"] },
          manifestRecords,
        }),
        resolveCandidatePluginIds,
        mapRegistryProviders,
      }),
    );

    expect(providers).toEqual(["provider"]);
    expect(resolveCandidatePluginIds).toHaveBeenCalledWith({
      config,
      workspaceDir: "/workspace",
      env: { BRAVE_API_KEY: "key" },
      onlyPluginIds: ["brave", "firecrawl"],
      origin: "bundled",
      sandboxed: true,
      manifestRecords,
    });
    expect(mapRegistryProviders).toHaveBeenCalledWith({
      registry: activeRegistry,
      onlyPluginIds: ["brave"],
    });
    expect(mockArg(mocks.buildPluginRuntimeLoadOptions).manifestRegistry).toEqual({
      plugins: manifestRecords,
      diagnostics: [],
    });
    expect(mocks.loadPluginRegistryHandleAsync).not.toHaveBeenCalled();
  });

  it("reuses the loaded registry for runtime web providers", async () => {
    const loadedRegistry = { source: "loaded" };
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(loadedRegistry as never);

    await resolvePluginWebProvidersAsync(
      {
        config: {},
        onlyPluginIds: ["brave"],
      },
      resolution({
        mapRegistryProviders,
      }),
    );

    expect(mockArg(mocks.getLoadedRuntimePluginRegistry).requiredPluginIds).toEqual(["brave"]);
    expect(mocks.loadPluginRegistryHandleAsync).not.toHaveBeenCalled();
  });

  it("caches setup web provider plugin loads by default", async () => {
    const loadedRegistry = { source: "setup" };
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    mocks.loadPluginRegistryHandleAsync.mockReturnValue(loadedRegistry as never);

    const providers = await resolvePluginWebProvidersAsync(
      {
        config: {},
        mode: "setup",
      },
      resolution({
        mapRegistryProviders,
        resolveBundledPublicArtifactProviders: () => null,
      }),
    );

    expect(providers).toEqual(["provider"]);
    expect(mockArg(mocks.loadPluginRegistryHandleAsync).cache).toBe(true);
    expect(mockArg(mocks.loadPluginRegistryHandleAsync).onlyPluginIds).toEqual(["brave"]);
  });

  it("uses bundled runtime artifacts before loading a plugin registry", async () => {
    const resolveBundledRuntimeArtifactProviders = vi.fn(() => ["provider"]);

    const providers = await resolvePluginWebProvidersAsync(
      {
        config: {},
        workspaceDir: "/workspace",
        env: { FIRECRAWL_API_KEY: "" },
      },
      resolution({
        resolveCandidatePluginIds: () => ["firecrawl"],
        mapRegistryProviders: vi.fn(() => []),
        resolveBundledRuntimeArtifactProviders,
      }),
    );

    expect(providers).toEqual(["provider"]);
    expect(resolveBundledRuntimeArtifactProviders).toHaveBeenCalledWith({
      config: {},
      workspaceDir: "/workspace",
      env: { FIRECRAWL_API_KEY: "" },
      onlyPluginIds: ["firecrawl"],
    });
    expect(mocks.loadPluginRegistryHandleAsync).not.toHaveBeenCalled();
  });

  it("falls back to plugin loading when bundled runtime artifacts do not cover the scope", async () => {
    const fallbackRegistry = { source: "fallback" };
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    const resolveBundledRuntimeArtifactProviders = vi.fn(() => null);
    mocks.loadPluginRegistryHandleAsync.mockReturnValue(fallbackRegistry as never);

    const providers = await resolvePluginWebProvidersAsync(
      {
        config: {},
      },
      resolution({
        resolveCandidatePluginIds: () => ["external-provider"],
        mapRegistryProviders,
        resolveBundledRuntimeArtifactProviders,
      }),
    );

    expect(providers).toEqual(["provider"]);
    expect(resolveBundledRuntimeArtifactProviders).toHaveBeenCalledTimes(1);
    expect(mocks.loadPluginRegistryHandleAsync).toHaveBeenCalledTimes(1);
    expect(mapRegistryProviders).toHaveBeenCalledWith({
      registry: fallbackRegistry,
      onlyPluginIds: ["external-provider"],
    });
  });

  it("falls back to a scoped provider load when the active runtime registry has no web providers", async () => {
    const activeRegistry = { source: "active" };
    const fallbackRegistry = { source: "fallback" };
    const mapRegistryProviders = vi.fn(({ registry }) =>
      registry === fallbackRegistry ? ["brave"] : [],
    );
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(activeRegistry as never);
    mocks.loadPluginRegistryHandleAsync.mockReturnValue(fallbackRegistry as never);

    const result = await resolvePluginWebProvidersAsync(
      {
        config: {},
      },
      resolution({
        resolveCandidatePluginIds: () => undefined,
        mapRegistryProviders,
      }),
    );

    expect(result).toEqual(["brave"]);
    expect(mocks.loadPluginRegistryHandleAsync).toHaveBeenCalledTimes(1);
    expect(mapRegistryProviders).toHaveBeenCalledTimes(2);
  });

  it("retains an empty request-owned web provider selection without registering plugins again", async () => {
    const registry = createEmptyPluginRegistry();
    const mapRegistryProviders = vi.fn(() => []);

    const result = await withPluginRuntimeRegistryScope(registry, () =>
      resolvePluginWebProvidersAsync(
        { config: {}, manifestRecords: [] },
        resolution({ resolveCandidatePluginIds: () => undefined, mapRegistryProviders }),
      ),
    );

    expect(result).toEqual([]);
    expect(mapRegistryProviders).toHaveBeenCalledExactlyOnceWith({
      registry,
      onlyPluginIds: undefined,
    });
    expect(mocks.getLoadedRuntimePluginRegistry).not.toHaveBeenCalled();
    expect(mocks.loadPluginRegistryHandleAsync).not.toHaveBeenCalled();
  });

  it.each([undefined, ["external-search"]])(
    "retains an exact generation's empty selection with candidates %j",
    async (candidates) => {
      const registry = createEmptyPluginRegistry();
      const requestRegistry = createEmptyPluginRegistry();
      const mapRegistryProviders = vi.fn(() => []);

      const result = await withPluginRuntimeRegistryScope(requestRegistry, () =>
        withPluginRuntimeGenerationRegistryScope(registry, () =>
          resolvePluginWebProvidersAsync(
            { config: {} },
            resolution({ resolveCandidatePluginIds: () => candidates, mapRegistryProviders }),
          ),
        ),
      );

      expect(result).toEqual([]);
      expect(mapRegistryProviders).toHaveBeenCalledExactlyOnceWith({
        registry,
        onlyPluginIds: candidates,
      });
      expect(mocks.getLoadedRuntimePluginRegistry).not.toHaveBeenCalled();
      expect(mocks.loadPluginRegistryHandleAsync).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "unknown inventory", manifestRecords: undefined, scopedProviders: [] },
    {
      name: "an uninspected provider",
      manifestRecords: [createPluginManifestRecordFixture({ id: "external-search" })],
      scopedProviders: [],
    },
    {
      name: "an uninspected provider alongside another provider",
      manifestRecords: [createPluginManifestRecordFixture({ id: "external-search" })],
      scopedProviders: ["scoped-search"],
    },
  ])(
    "discovers undeclared providers from a request scope with $name",
    async ({ manifestRecords, scopedProviders }) => {
      const registry = createEmptyPluginRegistry();
      const fallbackRegistry = createEmptyPluginRegistry();
      const mapRegistryProviders = vi.fn(({ registry: selected }) =>
        selected === fallbackRegistry ? ["external-search", "scoped-search"] : scopedProviders,
      );
      mocks.loadPluginRegistryHandleAsync.mockReturnValue(fallbackRegistry);

      const result = await withPluginRuntimeRegistryScope(registry, () =>
        resolvePluginWebProvidersAsync(
          { config: {}, manifestRecords },
          resolution({ resolveCandidatePluginIds: () => undefined, mapRegistryProviders }),
        ),
      );

      expect(result).toEqual(["external-search", "scoped-search"]);
      expect(mocks.getLoadedRuntimePluginRegistry).not.toHaveBeenCalled();
      expect(mocks.loadPluginRegistryHandleAsync).toHaveBeenCalledTimes(1);
    },
  );

  it("does not treat an active registry missing declared candidates as authoritative", async () => {
    // Regression: an active registry with SOME web providers used to win even when a
    // manifest-declared candidate (npm-installed Brave with BRAVE_API_KEY set) was
    // absent from it, so env-var auto-detect could never see the installed provider.
    const activeRegistry = { source: "active" };
    const scopedRegistry = { source: "scoped" };
    const mapRegistryProviders = vi.fn(({ registry }) =>
      registry === scopedRegistry ? ["brave", "grok"] : ["grok"],
    );
    mocks.getLoadedRuntimePluginRegistry.mockImplementation((args: unknown) => {
      const requiredPluginIds = (args as { requiredPluginIds?: readonly string[] })
        ?.requiredPluginIds;
      // Simulate active-registry coverage: brave never loaded at startup.
      if (requiredPluginIds?.includes("brave")) {
        return undefined;
      }
      return activeRegistry as never;
    });
    mocks.loadPluginRegistryHandleAsync.mockReturnValue(scopedRegistry as never);

    const result = await resolvePluginWebProvidersAsync(
      {
        config: {},
        env: { BRAVE_API_KEY: "key" } as never,
      },
      resolution({
        resolveCandidatePluginIds: () => ["brave", "xai"],
        mapRegistryProviders,
      }),
    );

    expect(result).toEqual(["brave", "grok"]);
    expect(mocks.loadPluginRegistryHandleAsync).toHaveBeenCalledTimes(1);
  });
});
