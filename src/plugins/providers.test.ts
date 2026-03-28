import { beforeEach, describe, expect, it, vi } from "vitest";

const loadOpenClawPluginsMock = vi.fn();
const loadPluginManifestRegistryMock = vi.fn();
const applyPluginAutoEnableMock = vi.fn();

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => loadOpenClawPluginsMock(...args),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => loadPluginManifestRegistryMock(...args),
}));

let resolveOwningPluginIdsForProvider: typeof import("./providers.js").resolveOwningPluginIdsForProvider;
let resolvePluginProviders: typeof import("./providers.runtime.js").resolvePluginProviders;

function setManifestPlugins(plugins: Array<Record<string, unknown>>) {
  loadPluginManifestRegistryMock.mockReturnValue({
    plugins,
    diagnostics: [],
  });
}

function getLastLoadPluginsCall(): Record<string, unknown> {
  const call = loadOpenClawPluginsMock.mock.calls.at(-1)?.[0];
  expect(call).toBeDefined();
  return (call ?? {}) as Record<string, unknown>;
}

function cloneOptions<T>(value: T): T {
  return structuredClone(value);
}

function expectResolvedProviders(providers: unknown, expected: unknown[]) {
  expect(providers).toEqual(expected);
}

function expectLastLoadPluginsCall(params?: {
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
}) {
  expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
    expect.objectContaining({
      cache: false,
      activate: false,
      ...(params?.env ? { env: params.env } : {}),
      ...(params?.onlyPluginIds ? { onlyPluginIds: params.onlyPluginIds } : {}),
    }),
  );
}

function getLastResolvedPluginConfig() {
  return getLastLoadPluginsCall().config as
    | {
        plugins?: {
          allow?: string[];
          entries?: Record<string, { enabled?: boolean }>;
        };
      }
    | undefined;
}

function createBundledProviderCompatOptions(params?: { onlyPluginIds?: readonly string[] }) {
  return {
    config: {
      plugins: {
        allow: ["openrouter"],
      },
    },
    bundledProviderAllowlistCompat: true,
    ...(params?.onlyPluginIds ? { onlyPluginIds: params.onlyPluginIds } : {}),
  };
}

function expectResolvedAllowlistState(params?: {
  expectedAllow?: readonly string[];
  unexpectedAllow?: readonly string[];
  expectedEntries?: Record<string, { enabled?: boolean }>;
  expectedOnlyPluginIds?: readonly string[];
}) {
  expectLastLoadPluginsCall(
    params?.expectedOnlyPluginIds ? { onlyPluginIds: params.expectedOnlyPluginIds } : undefined,
  );

  const config = getLastResolvedPluginConfig();
  const allow = config?.plugins?.allow ?? [];

  if (params?.expectedAllow) {
    expect(allow).toEqual(expect.arrayContaining([...params.expectedAllow]));
  }
  if (params?.expectedEntries) {
    expect(config?.plugins?.entries).toEqual(expect.objectContaining(params.expectedEntries));
  }
  params?.unexpectedAllow?.forEach((disallowedPluginId) => {
    expect(allow).not.toContain(disallowedPluginId);
  });
}

function expectOwningPluginIds(provider: string, expectedPluginIds?: string[]) {
  expect(resolveOwningPluginIdsForProvider({ provider })).toEqual(expectedPluginIds);
}

describe("resolvePluginProviders", () => {
  beforeEach(async () => {
    vi.resetModules();
    loadOpenClawPluginsMock.mockReset();
    loadOpenClawPluginsMock.mockReturnValue({
      providers: [{ pluginId: "google", provider: { id: "demo-provider" } }],
    });
    loadPluginManifestRegistryMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    applyPluginAutoEnableMock.mockImplementation((params: { config: unknown }) => ({
      config: params.config,
      changes: [],
    }));
    setManifestPlugins([
      { id: "google", providers: ["google"], origin: "bundled" },
      { id: "browser", providers: [], origin: "bundled" },
      { id: "kilocode", providers: ["kilocode"], origin: "bundled" },
      { id: "moonshot", providers: ["moonshot"], origin: "bundled" },
      { id: "google-gemini-cli-auth", providers: [], origin: "bundled" },
      { id: "workspace-provider", providers: ["workspace-provider"], origin: "workspace" },
    ]);
    ({ resolveOwningPluginIdsForProvider } = await import("./providers.js"));
    ({ resolvePluginProviders } = await import("./providers.runtime.js"));
  });

  it("forwards an explicit env to plugin loading", () => {
    const env = { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv;

    const providers = resolvePluginProviders({
      workspaceDir: "/workspace/explicit",
      env,
    });

    expectResolvedProviders(providers, [{ id: "demo-provider", pluginId: "google" }]);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/workspace/explicit",
        env,
        cache: false,
        activate: false,
      }),
    );
  });

  it.each([
    {
      name: "can augment restrictive allowlists for bundled provider compatibility",
      options: createBundledProviderCompatOptions(),
      expectedAllow: ["openrouter", "google", "kilocode", "moonshot"],
      expectedEntries: {
        google: { enabled: true },
        kilocode: { enabled: true },
        moonshot: { enabled: true },
      },
    },
    {
      name: "does not reintroduce the retired google auth plugin id into compat allowlists",
      options: createBundledProviderCompatOptions(),
      expectedAllow: ["google"],
      unexpectedAllow: ["google-gemini-cli-auth"],
    },
    {
      name: "does not inject non-bundled provider plugin ids into compat allowlists",
      options: createBundledProviderCompatOptions(),
      unexpectedAllow: ["workspace-provider"],
    },
    {
      name: "scopes bundled provider compat expansion to the requested plugin ids",
      options: createBundledProviderCompatOptions({
        onlyPluginIds: ["moonshot"],
      }),
      expectedAllow: ["openrouter", "moonshot"],
      unexpectedAllow: ["google", "kilocode"],
      expectedOnlyPluginIds: ["moonshot"],
    },
  ] as const)(
    "$name",
    ({ options, expectedAllow, expectedEntries, expectedOnlyPluginIds, unexpectedAllow }) => {
      resolvePluginProviders(
        cloneOptions(options) as unknown as Parameters<typeof resolvePluginProviders>[0],
      );

      expectResolvedAllowlistState({
        expectedAllow,
        expectedEntries,
        expectedOnlyPluginIds,
        unexpectedAllow,
      });
    },
  );

  it("can enable bundled provider plugins under Vitest when no explicit plugin config exists", () => {
    resolvePluginProviders({
      env: { VITEST: "1" } as NodeJS.ProcessEnv,
      bundledProviderVitestCompat: true,
    });

    expectLastLoadPluginsCall();
    expect(getLastResolvedPluginConfig()).toEqual(
      expect.objectContaining({
        plugins: expect.objectContaining({
          enabled: true,
          allow: expect.arrayContaining(["google", "moonshot"]),
          entries: expect.objectContaining({
            google: { enabled: true },
            moonshot: { enabled: true },
          }),
        }),
      }),
    );
  });

  it("does not leak host Vitest env into an explicit non-Vitest env", () => {
    const previousVitest = process.env.VITEST;
    process.env.VITEST = "1";
    try {
      resolvePluginProviders({
        env: {} as NodeJS.ProcessEnv,
        bundledProviderVitestCompat: true,
      });

      expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          config: undefined,
          env: {},
        }),
      );
    } finally {
      if (previousVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = previousVitest;
      }
    }
  });

  it("loads only provider plugins on the provider runtime path", () => {
    resolvePluginProviders({
      bundledProviderAllowlistCompat: true,
    });

    expectLastLoadPluginsCall({
      onlyPluginIds: ["google", "kilocode", "moonshot"],
    });
  });

  it("loads provider plugins from the auto-enabled config snapshot", () => {
    const rawConfig = {
      plugins: {},
    };
    const autoEnabledConfig = {
      ...rawConfig,
      plugins: {
        entries: {
          google: { enabled: true },
        },
      },
    };
    applyPluginAutoEnableMock.mockReturnValue({ config: autoEnabledConfig, changes: [] });

    resolvePluginProviders({ config: rawConfig });

    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
      config: rawConfig,
      env: process.env,
    });
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
      }),
    );
  });

  it("maps provider ids to owning plugin ids via manifests", () => {
    setManifestPlugins([
      { id: "minimax", providers: ["minimax", "minimax-portal"] },
      { id: "openai", providers: ["openai", "openai-codex"] },
    ]);

    expectOwningPluginIds("minimax-portal", ["minimax"]);
    expectOwningPluginIds("openai-codex", ["openai"]);
    expectOwningPluginIds("gemini-cli");
  });
});
