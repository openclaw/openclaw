import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isPluginRegistryLoadInFlight: vi.fn(() => false),
  loadOpenClawPlugins: vi.fn(),
  resolveCompatibleRuntimePluginRegistry: vi.fn(),
  resolveRuntimePluginRegistry: vi.fn(),
  getActivePluginRegistryWorkspaceDir: vi.fn(() => undefined),
  buildPluginRuntimeLoadOptionsFromValues: vi.fn(
    (_values: unknown, overrides?: Record<string, unknown>) => ({
      ...overrides,
    }),
  ),
  createPluginRuntimeLoaderLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock("./loader.js", () => ({
  isPluginRegistryLoadInFlight: mocks.isPluginRegistryLoadInFlight,
  loadOpenClawPlugins: mocks.loadOpenClawPlugins,
  resolveCompatibleRuntimePluginRegistry: mocks.resolveCompatibleRuntimePluginRegistry,
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
}));

vi.mock("./runtime.js", () => ({
  getActivePluginRegistryWorkspaceDir: mocks.getActivePluginRegistryWorkspaceDir,
}));

vi.mock("./runtime/load-context.js", () => ({
  buildPluginRuntimeLoadOptionsFromValues: mocks.buildPluginRuntimeLoadOptionsFromValues,
  createPluginRuntimeLoaderLogger: mocks.createPluginRuntimeLoaderLogger,
}));

let createWebProviderSnapshotCache: typeof import("./web-provider-runtime-shared.js").createWebProviderSnapshotCache;
let resolvePluginWebProviders: typeof import("./web-provider-runtime-shared.js").resolvePluginWebProviders;
let resolveRuntimeWebProviders: typeof import("./web-provider-runtime-shared.js").resolveRuntimeWebProviders;

describe("web-provider-runtime-shared", () => {
  beforeAll(async () => {
    ({ createWebProviderSnapshotCache, resolvePluginWebProviders, resolveRuntimeWebProviders } =
      await import("./web-provider-runtime-shared.js"));
  });

  beforeEach(() => {
    mocks.isPluginRegistryLoadInFlight.mockReset();
    mocks.isPluginRegistryLoadInFlight.mockReturnValue(false);
    mocks.loadOpenClawPlugins.mockReset();
    mocks.resolveCompatibleRuntimePluginRegistry.mockReset();
    mocks.resolveRuntimePluginRegistry.mockReset();
    mocks.getActivePluginRegistryWorkspaceDir.mockReset();
    mocks.getActivePluginRegistryWorkspaceDir.mockReturnValue(undefined);
    mocks.buildPluginRuntimeLoadOptionsFromValues.mockReset();
    mocks.buildPluginRuntimeLoadOptionsFromValues.mockImplementation(
      (_values: unknown, overrides?: Record<string, unknown>) => ({
        ...overrides,
      }),
    );
  });

  it("preserves explicit empty scopes in runtime-compatible web provider loads", () => {
    const mapRegistryProviders = vi.fn(() => []);
    mocks.resolveCompatibleRuntimePluginRegistry.mockReturnValue({} as never);

    resolvePluginWebProviders(
      {
        config: {},
        onlyPluginIds: [],
      },
      {
        snapshotCache: createWebProviderSnapshotCache(),
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => [],
        mapRegistryProviders,
      },
    );

    expect(mocks.resolveCompatibleRuntimePluginRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: [],
      }),
    );
    expect(mapRegistryProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: [],
      }),
    );
  });

  it("preserves explicit empty scopes in direct runtime web provider resolution", () => {
    const mapRegistryProviders = vi.fn(() => []);
    mocks.resolveRuntimePluginRegistry.mockReturnValue({} as never);

    resolveRuntimeWebProviders(
      {
        config: {},
        onlyPluginIds: [],
      },
      {
        snapshotCache: createWebProviderSnapshotCache(),
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => [],
        mapRegistryProviders,
      },
    );

    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: [],
      }),
    );
    expect(mapRegistryProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: [],
      }),
    );
  });

  it("preserves explicit scopes when config is omitted in direct runtime resolution", () => {
    const mapRegistryProviders = vi.fn(() => []);
    mocks.resolveRuntimePluginRegistry.mockReturnValue({} as never);

    resolveRuntimeWebProviders(
      {
        onlyPluginIds: ["alpha"],
      },
      {
        snapshotCache: createWebProviderSnapshotCache(),
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => ["alpha"],
        mapRegistryProviders,
      },
    );

    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith(undefined);
    expect(mapRegistryProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["alpha"],
      }),
    );
  });

  it("hits the snapshot cache when callers pass fresh-but-equal-content config objects (regression for #73730)", () => {
    process.env.OPENCLAW_PLUGIN_SNAPSHOT_CACHE_TTL_MS = "60000";
    process.env.OPENCLAW_PLUGIN_SNAPSHOT_CACHE = "1";
    try {
      const sharedCache = createWebProviderSnapshotCache();
      const sharedRegistry = { id: "registry" } as never;
      mocks.resolveCompatibleRuntimePluginRegistry.mockReturnValue(undefined as never);
      mocks.resolveRuntimePluginRegistry.mockReturnValue(undefined as never);
      mocks.loadOpenClawPlugins.mockReturnValue(sharedRegistry);

      const callsToLoadOpenClawPluginsBefore = mocks.loadOpenClawPlugins.mock.calls.length;

      const buildConfig = () => ({
        // Fresh object reference each call, identical content.
        plugins: {
          entries: { brave: { enabled: true } },
        },
      });

      const mapRegistryProviders = vi.fn(() => [{ id: "p1", pluginId: "brave" }]);

      // First call → cache miss, populates cache.
      resolvePluginWebProviders(
        { config: buildConfig() as never, onlyPluginIds: undefined },
        {
          snapshotCache: sharedCache,
          resolveBundledResolutionConfig: (params) => ({
            config: params.config,
            activationSourceConfig: params.config,
            autoEnabledReasons: {},
          }),
          resolveCandidatePluginIds: () => undefined,
          mapRegistryProviders,
        },
      );

      // Second call → fresh config object, identical content. Should HIT.
      resolvePluginWebProviders(
        { config: buildConfig() as never, onlyPluginIds: undefined },
        {
          snapshotCache: sharedCache,
          resolveBundledResolutionConfig: (params) => ({
            config: params.config,
            activationSourceConfig: params.config,
            autoEnabledReasons: {},
          }),
          resolveCandidatePluginIds: () => undefined,
          mapRegistryProviders,
        },
      );

      const loadCallsAfter =
        mocks.loadOpenClawPlugins.mock.calls.length - callsToLoadOpenClawPluginsBefore;

      // Pre-fix behavior: 2 calls (cache miss every time).
      // Post-fix behavior: 1 call (second call hits the content-keyed cache).
      expect(loadCallsAfter).toBe(1);
      expect(mapRegistryProviders).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.OPENCLAW_PLUGIN_SNAPSHOT_CACHE_TTL_MS;
      delete process.env.OPENCLAW_PLUGIN_SNAPSHOT_CACHE;
    }
  });

  it("misses the snapshot cache when config content actually differs (regression for #73730)", () => {
    process.env.OPENCLAW_PLUGIN_SNAPSHOT_CACHE_TTL_MS = "60000";
    process.env.OPENCLAW_PLUGIN_SNAPSHOT_CACHE = "1";
    try {
      const sharedCache = createWebProviderSnapshotCache();
      mocks.resolveCompatibleRuntimePluginRegistry.mockReturnValue(undefined as never);
      mocks.resolveRuntimePluginRegistry.mockReturnValue(undefined as never);
      mocks.loadOpenClawPlugins.mockReturnValue({ id: "registry" } as never);

      const callsToLoadBefore = mocks.loadOpenClawPlugins.mock.calls.length;

      const mapRegistryProviders = vi.fn(() => []);

      // First config: brave enabled.
      resolvePluginWebProviders(
        {
          config: { plugins: { entries: { brave: { enabled: true } } } } as never,
          onlyPluginIds: undefined,
        },
        {
          snapshotCache: sharedCache,
          resolveBundledResolutionConfig: (params) => ({
            config: params.config,
            activationSourceConfig: params.config,
            autoEnabledReasons: {},
          }),
          resolveCandidatePluginIds: () => undefined,
          mapRegistryProviders,
        },
      );

      // Second config: brave DISABLED — different resolution-relevant content.
      resolvePluginWebProviders(
        {
          config: { plugins: { entries: { brave: { enabled: false } } } } as never,
          onlyPluginIds: undefined,
        },
        {
          snapshotCache: sharedCache,
          resolveBundledResolutionConfig: (params) => ({
            config: params.config,
            activationSourceConfig: params.config,
            autoEnabledReasons: {},
          }),
          resolveCandidatePluginIds: () => undefined,
          mapRegistryProviders,
        },
      );

      const loadCallsAfter = mocks.loadOpenClawPlugins.mock.calls.length - callsToLoadBefore;
      // Different content fingerprints → both calls are cache misses.
      expect(loadCallsAfter).toBe(2);
    } finally {
      delete process.env.OPENCLAW_PLUGIN_SNAPSHOT_CACHE_TTL_MS;
      delete process.env.OPENCLAW_PLUGIN_SNAPSHOT_CACHE;
    }
  });
});
