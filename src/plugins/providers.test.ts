import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginAutoEnableResult } from "../config/plugin-auto-enable.types.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginRegistrySnapshot } from "./plugin-registry.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { ProviderPlugin } from "./types.js";

type ResolveRuntimePluginRegistry = typeof import("./loader.js").resolveRuntimePluginRegistry;
type LoadOpenClawPlugins = typeof import("./loader.js").loadOpenClawPlugins;
type IsPluginRegistryLoadInFlight = typeof import("./loader.js").isPluginRegistryLoadInFlight;
type LoadPluginManifestRegistry =
  typeof import("./manifest-registry.js").loadPluginManifestRegistryCore;
type LoadPluginMetadataSnapshot =
  typeof import("./plugin-metadata-snapshot.js").loadPluginMetadataSnapshot;
type LoadPluginRegistrySnapshot = typeof import("./plugin-registry.js").loadPluginRegistrySnapshot;
type LoadPluginRegistrySnapshotWithMetadata =
  typeof import("./plugin-registry.js").loadPluginRegistrySnapshotWithMetadata;
type ApplyPluginAutoEnable = typeof import("../config/plugin-auto-enable.js").applyPluginAutoEnable;
type SetActivePluginRegistry = typeof import("./runtime.js").setActivePluginRegistry;

const runtimeLoader = vi.fn<ResolveRuntimePluginRegistry>();
const setupLoader = vi.fn<LoadOpenClawPlugins>();
const isPluginRegistryLoadInFlightMock = vi.fn<IsPluginRegistryLoadInFlight>((_options) => false);
const manifestLoader = vi.fn<LoadPluginManifestRegistry>();
const metadataLoader = vi.fn<LoadPluginMetadataSnapshot>();
const indexLoader = vi.fn<LoadPluginRegistrySnapshot>();
const indexWithMetadataLoader = vi.fn<LoadPluginRegistrySnapshotWithMetadata>();
const currentMetadata = vi.fn();
const autoEnable = vi.fn<ApplyPluginAutoEnable>();

let owners: typeof import("./providers.js");
let resolvePluginProviders: typeof import("./providers.runtime.js").resolvePluginProvidersCore;
let setActivePluginRegistry: SetActivePluginRegistry;

function manifest(id: string, overrides: Partial<PluginManifestRecord> = {}): PluginManifestRecord {
  return {
    id,
    providers: [id],
    channels: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: `/tmp/${id}`,
    source: overrides.origin ?? "bundled",
    manifestPath: `/tmp/${id}/openclaw.plugin.json`,
    ...overrides,
  };
}

function setManifestPlugins(plugins: PluginManifestRecord[]) {
  manifestLoader.mockReturnValue({ plugins, diagnostics: [] });
}

function setManifest(id: string, overrides: Partial<PluginManifestRecord> = {}) {
  setManifestPlugins([manifest(id, overrides)]);
}

function setOwningProviderManifestPlugins() {
  setManifestPlugins([
    manifest("minimax", { providers: ["minimax", "minimax-portal"] }),
    manifest("openai", {
      providers: ["openai", "openai"],
      modelSupport: { modelPrefixes: ["gpt-", "o1", "o3", "o4"] },
    }),
    manifest("anthropic", {
      cliBackends: ["claude-cli"],
      modelSupport: { modelPrefixes: ["claude-"] },
    }),
  ]);
}

function createProviderRegistrySnapshotFixture(): PluginRegistrySnapshot {
  const plugins = manifestLoader().plugins.map((plugin) => {
    const snapshotPlugin = {
      pluginId: plugin.id,
      manifestPath: plugin.manifestPath,
      manifestHash: `test-${plugin.id}`,
      source: plugin.source,
      rootDir: plugin.rootDir,
      origin: plugin.origin,
      enabled: plugin.enabledByDefault !== false,
      syntheticAuthRefs: plugin.syntheticAuthRefs,
      startup: { sidecar: false, memory: false, agentHarnesses: [] },
      compat: [],
    };
    if (plugin.enabledByDefault === true) {
      Object.assign(snapshotPlugin, { enabledByDefault: true });
    }
    return snapshotPlugin;
  });

  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 0,
    installRecords: {},
    plugins,
    diagnostics: [],
  };
}

function providerRegistry(provider: ProviderPlugin, pluginId = provider.id) {
  const registry = createEmptyPluginRegistry();
  registry.providers.push({ pluginId, provider, source: "bundled" });
  return registry;
}

function getLastRuntimeRegistryCall() {
  const call = runtimeLoader.mock.calls.at(-1)?.[0];
  expect(call).toBeDefined();
  return call;
}

function expectActivatedOwner(
  id: string,
  mode: "runtime" | "setup" = "runtime",
  activate?: boolean,
) {
  const call =
    mode === "runtime" ? getLastRuntimeRegistryCall() : setupLoader.mock.calls.at(-1)?.[0];
  expect(call?.onlyPluginIds).toEqual([id]);
  if (activate !== undefined) {
    expect(call?.activate).toBe(activate);
  }
  expect(call?.config?.plugins?.allow).toContain(id);
  expect(call?.config?.plugins?.entries?.[id]).toEqual({ enabled: true });
}

function expectModelOwningPluginIds(model: string, expectedPluginIds?: readonly string[]) {
  expect(owners.resolveOwningPluginIdsForModelRef({ model })).toEqual(expectedPluginIds);
}

describe("resolvePluginProviders", () => {
  beforeAll(async () => {
    vi.resetModules();
    setManifestPlugins([]);
    vi.doMock("./loader.js", () => ({
      loadOpenClawPlugins: setupLoader,
      isPluginRegistryLoadInFlight: isPluginRegistryLoadInFlightMock,
      resolveRuntimePluginRegistry: runtimeLoader,
    }));
    vi.doMock("./providers.runtime.js", async () => {
      const { createProviderRegistryResolver } = await import("./providers.runtime-core.js");
      const loader = await import("./loader.js");
      return createProviderRegistryResolver(loader);
    });
    vi.doMock("../config/plugin-auto-enable.js", () => ({
      applyPluginAutoEnable: autoEnable,
    }));
    vi.doMock("./manifest-registry.js", () => ({
      loadPluginManifestRegistryCore: manifestLoader,
    }));
    vi.doMock("./plugin-metadata-snapshot.js", () => {
      const loadSnapshot = (params: Parameters<LoadPluginMetadataSnapshot>[0]) => {
        metadataLoader(params);
        return {
          manifestRegistry: manifestLoader(),
          index: createProviderRegistrySnapshotFixture(),
        };
      };
      return {
        loadPluginMetadataSnapshot: loadSnapshot,
        resolvePluginMetadataSnapshot: loadSnapshot,
      };
    });
    vi.doMock("./current-plugin-metadata-snapshot.js", () => ({
      getCurrentPluginMetadataSnapshot: currentMetadata,
    }));
    vi.doMock("./plugin-registry.js", async () => {
      const actual =
        await vi.importActual<typeof import("./plugin-registry.js")>("./plugin-registry.js");
      return {
        ...actual,
        loadPluginRegistrySnapshot: indexLoader,
        loadPluginRegistrySnapshotWithMetadata: indexWithMetadataLoader,
      };
    });
    vi.doMock("./installed-plugin-index-store.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./installed-plugin-index-store.js")>();
      return {
        ...actual,
        readPersistedInstalledPluginIndexSync: () => null,
      };
    });
    owners = await import("./providers.js");
    ({ resolvePluginProvidersCore: resolvePluginProviders } =
      await import("./providers.runtime.js"));
    ({ setActivePluginRegistry } = await import("./runtime.js"));
  });

  it("offers only opted-in personal methods under the installed plugin policy", async () => {
    const { listPersonalAccountAuthChoices, resolvePersonalAccountAuthMethod } =
      await import("./personal-account-auth.js");
    const bundled = manifest("personal-provider");
    bundled.providerAuthChoices = [
      {
        provider: "personal-provider",
        method: "api-key",
        choiceId: "personal-key",
        personalAccount: true,
      },
      { provider: "personal-provider", method: "host-import", choiceId: "host-import" },
    ];
    const workspace = manifest("workspace-provider", { origin: "workspace" });
    workspace.providerAuthChoices = [
      {
        provider: "workspace-provider",
        method: "api-key",
        choiceId: "workspace-key",
        personalAccount: true,
      },
    ];
    setManifestPlugins([bundled, workspace]);
    expect(listPersonalAccountAuthChoices({}).map((choice) => choice.choiceId)).toEqual([
      "personal-key",
    ]);
    for (const plugins of [
      { enabled: false },
      { deny: ["personal-provider"] },
      { allow: ["unrelated"] },
      { entries: { "personal-provider": { enabled: false } } },
    ]) {
      expect(listPersonalAccountAuthChoices({ plugins })).toEqual([]);
      expect(
        await resolvePersonalAccountAuthMethod({ plugins }, "personal-provider", "api-key"),
      ).toBeUndefined();
    }
    expect(
      await resolvePersonalAccountAuthMethod({}, "personal-provider", "host-import"),
    ).toBeUndefined();
    expect(setupLoader).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "resolves installed owners with prepared manifest metadata: %s",
    (prepared) => {
      const plugins = [
        manifest("first-owner", { providers: ["direct-provider"], cliBackends: ["shared-cli"] }),
        manifest("second-owner", {
          providers: [],
          setup: { cliBackends: ["SHARED-CLI"] },
          enabledByDefault: false,
        }),
      ];
      setManifestPlugins(plugins);
      const snapshot = createProviderRegistrySnapshotFixture();
      indexLoader.mockReturnValue(snapshot);
      indexWithMetadataLoader.mockReturnValue({
        snapshot,
        source: "derived",
        diagnostics: [],
        ...(prepared
          ? {
              manifestRegistry: {
                plugins: [
                  ...plugins,
                  manifest("not-installed", {
                    providers: ["direct-provider"],
                    cliBackends: ["shared-cli"],
                  }),
                ],
                diagnostics: [],
              },
            }
          : {}),
      });
      manifestLoader.mockClear();

      expect(owners.resolveProviderRefOwnership({ provider: " DIRECT-PROVIDER " })).toEqual({
        status: "owned",
        pluginIds: ["first-owner"],
      });
      expect(owners.resolveProviderRefOwnership({ provider: " Shared-CLI " })).toEqual({
        status: "ambiguous",
        pluginIds: ["first-owner", "second-owner"],
      });
      expect(manifestLoader).toHaveBeenCalledTimes(prepared ? 0 : 2);
    },
  );

  it("reuses one registry snapshot across explicit model ownership lookups", () => {
    setOwningProviderManifestPlugins();

    expect(
      owners.resolveOwningPluginIdsForModelRefs({
        models: ["openai/gpt-5.6-luna", "claude-cli/claude-sonnet-4-6"],
      }),
    ).toEqual(["anthropic", "openai"]);
    expect(metadataLoader).not.toHaveBeenCalled();
    expect(indexLoader).toHaveBeenCalledOnce();
  });

  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    runtimeLoader.mockReset();
    setupLoader.mockReset();
    isPluginRegistryLoadInFlightMock.mockReset();
    isPluginRegistryLoadInFlightMock.mockReturnValue(false);
    metadataLoader.mockReset();
    indexLoader.mockReset();
    indexLoader.mockImplementation(() => createProviderRegistrySnapshotFixture());
    indexWithMetadataLoader.mockReset();
    indexWithMetadataLoader.mockImplementation(() => ({
      snapshot: createProviderRegistrySnapshotFixture(),
      source: "derived",
      diagnostics: [],
    }));
    currentMetadata.mockReset();
    currentMetadata.mockReturnValue(undefined);
    const registry = providerRegistry(
      {
        id: "demo-provider",
        label: "Demo Provider",
        auth: [],
      },
      "google",
    );
    runtimeLoader.mockReturnValue(registry);
    setupLoader.mockReturnValue(registry);
    manifestLoader.mockReset();
    autoEnable.mockReset();
    autoEnable.mockImplementation((params): PluginAutoEnableResult => ({
      config: params.config ?? {},
      changes: [],
      autoEnabledReasons: {},
    }));
    setManifestPlugins([
      manifest("google", { enabledByDefault: true }),
      manifest("browser", { providers: [] }),
      manifest("kilocode", { enabledByDefault: true }),
      manifest("moonshot", { enabledByDefault: true }),
      manifest("google-gemini-cli-auth", { providers: [] }),
      manifest("workspace-provider", {
        origin: "workspace",
        modelSupport: {
          modelPrefixes: ["workspace-model-"],
        },
      }),
    ]);
  });

  it("loads catalog augment hooks only for declarative runtime catalog manifests", () => {
    setManifestPlugins([
      manifest("static-bundled", {
        enabledByDefault: true,
        modelCatalog: {
          providers: {
            "static-bundled": {
              models: [{ id: "static-model" }],
            },
          },
        },
      }),
      manifest("runtime-bundled", {
        enabledByDefault: true,
        modelCatalog: {
          runtimeAugment: true,
        },
      }),
      manifest("workspace-runtime", { enabledByDefault: true, origin: "workspace" }),
    ]);

    expect(owners.resolveCatalogHookProviderPluginIds({ config: {}, env: {} })).toEqual([
      "runtime-bundled",
    ]);
  });

  it("resolves external auth hook plugin ids from manifest contracts without runtime loading", () => {
    setManifestPlugins([
      manifest("external-auth-owner", {
        providers: ["demo"],
        contracts: { externalAuthProviders: ["demo"] },
      }),
      manifest("regular-provider", { providers: ["regular"] }),
    ]);

    expect(
      owners.resolveExternalAuthProfileProviderPluginIds({
        config: {},
        env: {},
      }),
    ).toEqual(["external-auth-owner"]);
    expect(runtimeLoader).not.toHaveBeenCalled();
  });

  it("treats explicit empty provider scopes as scoped-empty in provider helpers", () => {
    expect(
      owners.resolveEnabledProviderPluginIds({
        config: {},
        env: {},
        onlyPluginIds: [],
      }),
    ).toStrictEqual([]);
    expect(
      owners.resolveDiscoveredProviderPluginIds({
        config: {},
        env: {},
        onlyPluginIds: [],
      }),
    ).toStrictEqual([]);
  });

  it("inherits workspaceDir from the active registry when provider resolution omits it", () => {
    setActivePluginRegistry(
      createEmptyPluginRegistry(),
      undefined,
      "default",
      "/workspace/runtime",
    );

    resolvePluginProviders({
      config: { plugins: { allow: ["google"] } },
      onlyPluginIds: ["google"],
    });

    expect(getLastRuntimeRegistryCall()).toMatchObject({
      workspaceDir: "/workspace/runtime",
      cache: true,
      activate: false,
    });
  });

  it("activates the owner plugin for custom provider refs that use a native provider api", () => {
    setManifest("ollama", { enabledByDefault: true });

    resolvePluginProviders({
      config: {
        models: {
          providers: {
            "ollama-spark": {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      providerRefs: ["ollama-spark"],
      activate: true,
    });

    expectActivatedOwner("ollama", "runtime", true);
  });

  it("uses setup.providers to keep explicit provider owners on the setup path", () => {
    setManifest("setup-owned-provider", {
      providers: [],
      setup: {
        providers: [{ id: "setup-owned" }],
      },
    });

    resolvePluginProviders({
      config: {},
      providerRefs: ["setup-owned"],
      activate: true,
      mode: "setup",
    });

    expectActivatedOwner("setup-owned-provider", "setup", true);
  });

  it("does not override global plugin disable during setup owner loading", () => {
    setManifest("setup-owned-provider", {
      providers: [],
      setup: {
        providers: [{ id: "setup-owned" }],
      },
    });

    resolvePluginProviders({
      config: { plugins: { enabled: false } },
      providerRefs: ["setup-owned"],
      activate: true,
      mode: "setup",
    });

    expect(setupLoader).not.toHaveBeenCalled();
  });

  it("does not auto-activate workspace runtime owners by default", () => {
    setManifest("workspace-activation-owner", {
      providers: [],
      origin: "workspace",
      activation: {
        onProviders: ["workspace-activation"],
      },
    });
    runtimeLoader.mockReturnValue(createEmptyPluginRegistry());

    const providers = resolvePluginProviders({
      config: {},
      providerRefs: ["workspace-activation"],
      activate: true,
    });

    expect(providers).toStrictEqual([]);
    expect(runtimeLoader).not.toHaveBeenCalled();
  });

  it("prefers non-bundled shorthand model ownership over bundled matches", () => {
    setManifestPlugins([
      manifest("openai", { modelSupport: { modelPrefixes: ["gpt-"] } }),
      manifest("workspace-openai", {
        origin: "workspace",
        modelSupport: { modelPrefixes: ["gpt-"] },
      }),
    ]);

    expectModelOwningPluginIds("gpt-5.4", ["workspace-openai"]);
  });

  it("rejects unsafe model patterns that would match the model", () => {
    setManifest("malicious", {
      modelSupport: {
        modelPatterns: ["(a+)+$"],
      },
    });

    // An unguarded pattern would match and incorrectly claim the model.
    expectModelOwningPluginIds("a", undefined);
  });

  it("preserves LM Studio @iq* quant suffixes when resolving model-owned provider plugins", () => {
    setManifestPlugins([
      manifest("lmstudio", {
        modelSupport: {
          modelPatterns: ["^qwen3\\.6-27b@iq3_xxs$"],
        },
      }),
      manifest("workspace-prefix", {
        origin: "workspace",
        modelSupport: { modelPrefixes: ["qwen3.6-27b@"] },
      }),
    ]);
    const registry = providerRegistry(
      {
        id: "lmstudio",
        label: "LM Studio",
        auth: [],
      },
      "lmstudio",
    );
    runtimeLoader.mockReturnValue(registry);

    expectModelOwningPluginIds("qwen3.6-27b@iq3_xxs", ["lmstudio"]);
    expectModelOwningPluginIds("qwen3.6-27b", undefined);

    const providers = resolvePluginProviders({
      config: {},
      modelRefs: ["qwen3.6-27b@iq3_xxs"],
    });

    expect(providers).toEqual([
      { id: "lmstudio", label: "LM Studio", auth: [], pluginId: "lmstudio" },
    ]);
    expectActivatedOwner("lmstudio");
  });

  it("auto-loads a same-id prefix record after ambiguous pattern matches", () => {
    setManifestPlugins([
      manifest("openai", {
        providers: ["openai", "openai"],
        modelSupport: {
          modelPrefixes: ["gpt-", "o1", "o3", "o4"],
        },
      }),
      ...["openai", "second-pattern"].map((id) =>
        manifest(id, {
          modelSupport: { modelPatterns: ["^gpt-"], modelPrefixes: ["gpt-"] },
        }),
      ),
    ]);
    const registry = providerRegistry(
      {
        id: "openai",
        label: "OpenAI",
        auth: [],
      },
      "openai",
    );
    runtimeLoader.mockReturnValue(registry);

    const providers = resolvePluginProviders({
      config: {},
      modelRefs: ["gpt-5.4"],
    });

    expect(providers).toEqual([{ id: "openai", label: "OpenAI", auth: [], pluginId: "openai" }]);
    expectActivatedOwner("openai");
  });
});
