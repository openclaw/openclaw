// Covers web fetch provider runtime hooks supplied by plugins.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "./test-helpers/cold-plugin-fixtures.js";

type LoaderModule = typeof import("./loader.js");
type ManifestRegistryModule = typeof import("./manifest-registry.js");
type RuntimeModule = typeof import("./runtime.js");
type WebFetchProvidersRuntimeModule = typeof import("./web-fetch-providers.runtime.js");
type WebProviderResolutionModule = typeof import("./web-provider-resolution-shared.js");

let loaderModule: LoaderModule;
let manifestRegistryModule: ManifestRegistryModule;
let webProviderResolutionModule: WebProviderResolutionModule;
let loadOpenClawPluginsMock: ReturnType<typeof vi.fn>;
let setActivePluginRegistry: RuntimeModule["setActivePluginRegistry"];
let resetPluginRuntimeStateForTest: RuntimeModule["resetPluginRuntimeStateForTest"];
let resolvePluginWebFetchProviders: WebFetchProvidersRuntimeModule["resolvePluginWebFetchProviders"];

const DEFAULT_WORKSPACE = "/tmp/workspace";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type PluginLoadOptions = { logger?: Record<string, unknown> } & Record<string, unknown>;

function firstPluginLoadOptions(mock: { mock: { calls: unknown[][] } }): PluginLoadOptions {
  return (mock.mock.calls[0]?.[0] ?? {}) as PluginLoadOptions;
}

function createWebFetchEnv(overrides?: Partial<NodeJS.ProcessEnv>) {
  return {
    OPENCLAW_HOME: "/tmp/openclaw-home",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function createFirecrawlAllowConfig() {
  return {
    plugins: {
      allow: ["firecrawl"],
    },
  };
}

function createManifestRegistryFixture(
  origin: "bundled" | "global" = "bundled",
  rootDir = "/tmp/firecrawl",
  source = path.join(rootDir, "index.js"),
): ReturnType<ManifestRegistryModule["loadPluginManifestRegistryCore"]> {
  return {
    plugins: [
      {
        id: "firecrawl",
        origin,
        rootDir,
        source,
        manifestPath: path.join(rootDir, "openclaw.plugin.json"),
        channels: [],
        providers: [],
        cliBackends: [],
        syntheticAuthRefs: [],
        nonSecretAuthMarkers: [],
        skills: [],
        hooks: [],
        contracts: { webFetchProviders: ["firecrawl"] },
        configUiHints: { "webFetch.apiKey": { label: "key" } },
      },
      {
        id: "noise",
        origin: "bundled",
        rootDir: "/tmp/noise",
        source: "/tmp/noise/index.js",
        manifestPath: "/tmp/noise/openclaw.plugin.json",
        channels: [],
        providers: [],
        cliBackends: [],
        syntheticAuthRefs: [],
        nonSecretAuthMarkers: [],
        skills: [],
        hooks: [],
        configUiHints: { unrelated: { label: "nope" } },
      },
    ],
    diagnostics: [],
  };
}

function createRuntimeWebFetchProvider() {
  return {
    pluginId: "firecrawl",
    pluginName: "Firecrawl",
    source: "test" as const,
    provider: {
      id: "firecrawl",
      label: "Firecrawl",
      hint: "Firecrawl runtime provider",
      envVars: ["FIRECRAWL_API_KEY"],
      placeholder: "firecrawl-...",
      signupUrl: "https://example.com/firecrawl",
      credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
      getCredentialValue: () => "configured",
      setCredentialValue: () => {},
      createTool: () => ({
        description: "firecrawl",
        parameters: {},
        execute: async () => ({}),
      }),
    },
  };
}

describe("resolvePluginWebFetchProviders", () => {
  beforeAll(async () => {
    vi.doMock("./plugin-registry-snapshot.js", async () => {
      const actual = await vi.importActual<typeof import("./plugin-registry-snapshot.js")>(
        "./plugin-registry-snapshot.js",
      );
      return {
        ...actual,
        loadPluginRegistrySnapshotWithMetadata: () => ({
          snapshot: { plugins: [], diagnostics: [] },
          source: "derived",
          diagnostics: [],
        }),
      };
    });
    loaderModule = await import("./loader.js");
    manifestRegistryModule = await import("./manifest-registry.js");
    webProviderResolutionModule = await import("./web-provider-resolution-shared.js");
    ({ resetPluginRuntimeStateForTest, setActivePluginRegistry } = await import("./runtime.js"));
    ({ resolvePluginWebFetchProviders } = await import("./web-fetch-providers.runtime.js"));
  });

  beforeEach(() => {
    vi.spyOn(manifestRegistryModule, "loadPluginManifestRegistryCore").mockReturnValue(
      createManifestRegistryFixture(),
    );
    loadOpenClawPluginsMock = vi
      .spyOn(loaderModule, "loadOpenClawPlugins")
      .mockImplementation(() => {
        const registry = createEmptyPluginRegistry();
        registry.webFetchProviders = [createRuntimeWebFetchProvider()];
        return registry;
      });
    resetPluginRuntimeStateForTest();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    vi.restoreAllMocks();
  });

  it("loads bundled runtime artifacts when no compatible active registry exists", () => {
    const fixture = createColdPluginFixture({
      rootDir: tempDirs.make("openclaw-web-fetch-artifact-"),
      pluginId: "firecrawl",
      packageJson: { type: "commonjs" },
      manifest: { contracts: { webFetchProviders: ["firecrawl"] } },
    });
    fs.writeFileSync(
      path.join(fixture.rootDir, "web-fetch-provider.js"),
      `exports.createFixtureWebFetchProvider = () => ({
        id: "firecrawl", label: "Selected fixture", hint: "fixture", envVars: [],
        placeholder: "", signupUrl: "", credentialPath: "apiKey",
        getCredentialValue() {}, setCredentialValue() {}, createTool() { return null; },
      });`,
    );
    vi.mocked(manifestRegistryModule.loadPluginManifestRegistryCore).mockReturnValue(
      createManifestRegistryFixture("bundled", fixture.rootDir, fixture.runtimeSource),
    );
    const providers = resolvePluginWebFetchProviders({});

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "firecrawl:firecrawl",
    ]);
    expect(providers[0]?.label).toBe("Selected fixture");
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("falls back to the plugin loader for non-bundled provider owners", () => {
    vi.mocked(manifestRegistryModule.loadPluginManifestRegistryCore).mockReturnValue(
      createManifestRegistryFixture("global"),
    );

    const providers = resolvePluginWebFetchProviders({});

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "firecrawl:firecrawl",
    ]);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "denylisted",
      config: { plugins: { deny: ["firecrawl"] } },
    },
    {
      label: "explicitly disabled",
      config: { plugins: { entries: { firecrawl: { enabled: false } } } },
    },
  ])("does not load $label bundled runtime artifacts", ({ config }) => {
    const providers = resolvePluginWebFetchProviders({ config });

    expect(providers).toStrictEqual([]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("loads manifest-declared web-fetch providers in setup mode without the plugin loader", () => {
    const providers = resolvePluginWebFetchProviders({
      config: createFirecrawlAllowConfig(),
      mode: "setup",
    });

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "firecrawl:firecrawl",
    ]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("does not force a fresh snapshot load when the same web-provider load is already in flight", () => {
    const inFlightSpy = vi
      .spyOn(loaderModule, "isPluginRegistryLoadInFlight")
      .mockReturnValue(true);
    loadOpenClawPluginsMock.mockImplementation(() => {
      throw new Error("resolvePluginWebFetchProviders should not bypass the in-flight guard");
    });
    const rawConfig = createFirecrawlAllowConfig();
    const env = createWebFetchEnv();
    const { config, activationSourceConfig, autoEnabledReasons } =
      webProviderResolutionModule.resolveBundledWebProviderResolutionConfig({
        contract: "webFetchProviders",
        config: rawConfig,
        workspaceDir: DEFAULT_WORKSPACE,
        env,
      });

    const providers = resolvePluginWebFetchProviders({
      config: rawConfig,
      workspaceDir: DEFAULT_WORKSPACE,
      env,
    });

    expect(providers).toStrictEqual([]);
    const { logger: inFlightLogger, ...inFlightLoadOptions } = firstPluginLoadOptions(inFlightSpy);
    expect(Object.keys(inFlightLogger ?? {}).toSorted()).toEqual([
      "debug",
      "error",
      "info",
      "warn",
    ]);
    expect(inFlightLoadOptions).toEqual({
      config,
      activationSourceConfig,
      autoEnabledReasons,
      workspaceDir: DEFAULT_WORKSPACE,
      env,
      cache: true,
      activate: false,
      onlyPluginIds: ["firecrawl"],
      installRecords: undefined,
      manifestRegistry: undefined,
    });
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("uses the active registry workspace for candidate discovery when workspaceDir is omitted", () => {
    const env = createWebFetchEnv();
    const rawConfig = createFirecrawlAllowConfig();

    setActivePluginRegistry(
      createEmptyPluginRegistry(),
      undefined,
      "default",
      "/tmp/runtime-workspace",
    );
    vi.mocked(manifestRegistryModule.loadPluginManifestRegistryCore).mockReturnValue(
      createManifestRegistryFixture("global"),
    );

    resolvePluginWebFetchProviders({
      config: rawConfig,
      env,
    });

    expect(manifestRegistryModule.loadPluginManifestRegistryCore).toHaveBeenCalledWith({
      config: rawConfig,
      workspaceDir: "/tmp/runtime-workspace",
      env,
      candidates: [],
      diagnostics: [],
      installRecords: {},
      registryPath: "/tmp/openclaw-home/.openclaw/state/openclaw.sqlite",
    });
    const { logger, ...loadOptions } = firstPluginLoadOptions(loadOpenClawPluginsMock);
    expect(Object.keys(logger ?? {}).toSorted()).toEqual(["debug", "error", "info", "warn"]);
    expect(loadOptions).toEqual({
      config: createFirecrawlAllowConfig(),
      activationSourceConfig: createFirecrawlAllowConfig(),
      autoEnabledReasons: {},
      workspaceDir: "/tmp/runtime-workspace",
      env,
      cache: true,
      activate: false,
      onlyPluginIds: ["firecrawl"],
    });
  });

  it("resolves web-fetch providers for each active registry workspace", () => {
    const env = createWebFetchEnv();
    const config = createFirecrawlAllowConfig();
    vi.mocked(manifestRegistryModule.loadPluginManifestRegistryCore).mockReturnValue(
      createManifestRegistryFixture("global"),
    );

    setActivePluginRegistry(createEmptyPluginRegistry(), undefined, "default", "/tmp/workspace-a");
    resolvePluginWebFetchProviders({
      config,
      env,
    });

    setActivePluginRegistry(createEmptyPluginRegistry(), undefined, "default", "/tmp/workspace-b");
    resolvePluginWebFetchProviders({
      config,
      env,
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(2);
  });
});
