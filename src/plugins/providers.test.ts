import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginAutoEnableResult } from "../config/plugin-auto-enable.types.js";
import type * as Loader from "./loader.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { createEmptyPluginMetadataSnapshot } from "./plugin-metadata-empty.test-support.js";
import type * as Registry from "./plugin-registry.js";
import type { PluginRegistrySnapshot } from "./plugin-registry.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

type LoadPluginManifestRegistry =
  typeof import("./manifest-registry.js").loadPluginManifestRegistryCore;
type LoadPluginMetadataSnapshot =
  typeof import("./plugin-metadata-snapshot.js").loadPluginMetadataSnapshot;
type ApplyPluginAutoEnable = typeof import("../config/plugin-auto-enable.js").applyPluginAutoEnable;

const runtimeLoader = vi.fn<typeof Loader.resolveRuntimePluginRegistry>();
const setupLoader = vi.fn<typeof Loader.loadOpenClawPlugins>();
const manifestLoader = vi.fn<LoadPluginManifestRegistry>();
const metadataLoader = vi.fn<LoadPluginMetadataSnapshot>();
const indexLoader = vi.fn<typeof Registry.loadPluginRegistrySnapshot>();
const indexWithMetadataLoader = vi.fn<typeof Registry.loadPluginRegistrySnapshotWithMetadata>();

let owners: typeof import("./providers.js");
let resolvePluginProviders: typeof import("./providers.runtime.js").resolvePluginProvidersCore;
let setActivePluginRegistry: typeof import("./runtime.js").setActivePluginRegistry;

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

function supported(
  id: string,
  modelSupport: PluginManifestRecord["modelSupport"],
  origin?: PluginManifestRecord["origin"],
) {
  return manifest(id, { modelSupport, ...(origin ? { origin } : {}) });
}

function registrySnapshot(): PluginRegistrySnapshot {
  const plugins = manifestLoader().plugins.map((plugin) =>
    Object.assign(
      {
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
      },
      plugin.enabledByDefault === true ? { enabledByDefault: true } : {},
    ),
  );
  return {
    ...createEmptyPluginMetadataSnapshot().index,
    policyHash: "test",
    generatedAtMs: 0,
    plugins,
  };
}

function providerRegistry(id: string, label: string, pluginId = id) {
  const registry = createEmptyPluginRegistry();
  registry.providers.push({ pluginId, provider: { id, label, auth: [] }, source: "bundled" });
  return registry;
}

function expectActivatedOwner(
  id: string,
  mode: "runtime" | "setup" = "runtime",
  activate?: boolean,
) {
  const call = (mode === "runtime" ? runtimeLoader : setupLoader).mock.calls.at(-1)?.[0];
  expect(call?.onlyPluginIds).toEqual([id]);
  if (activate !== undefined) {
    expect(call?.activate).toBe(activate);
  }
  expect(call?.config?.plugins?.allow).toContain(id);
  expect(call?.config?.plugins?.entries?.[id]).toEqual({ enabled: true });
}

function expectOwners(model: string, expectedPluginIds?: readonly string[]) {
  expect(owners.resolveOwningPluginIdsForModelRef({ model })).toEqual(expectedPluginIds);
}

describe("resolvePluginProviders", () => {
  beforeAll(async () => {
    vi.resetModules();
    setManifestPlugins([]);
    vi.doMock("./loader.js", () => ({
      loadOpenClawPlugins: setupLoader,
      isPluginRegistryLoadInFlight: () => false,
      resolveRuntimePluginRegistry: runtimeLoader,
    }));
    vi.doMock("./providers.runtime.js", async () => {
      const { createProviderRegistryResolver } = await import("./providers.runtime-core.js");
      const loader = await import("./loader.js");
      return createProviderRegistryResolver(loader);
    });
    vi.doMock("../config/plugin-auto-enable.js", () => ({
      applyPluginAutoEnable: (
        params: Parameters<ApplyPluginAutoEnable>[0],
      ): PluginAutoEnableResult => ({
        config: params.config ?? {},
        changes: [],
        autoEnabledReasons: {},
      }),
    }));
    vi.doMock("./manifest-registry.js", () => ({
      loadPluginManifestRegistryCore: manifestLoader,
    }));
    vi.doMock("./plugin-metadata-snapshot.js", () => {
      const loadSnapshot = (params: Parameters<LoadPluginMetadataSnapshot>[0]) => {
        metadataLoader(params);
        return {
          manifestRegistry: manifestLoader(),
          index: registrySnapshot(),
        };
      };
      return {
        loadPluginMetadataSnapshot: loadSnapshot,
        resolvePluginMetadataSnapshot: loadSnapshot,
      };
    });
    vi.doMock("./current-plugin-metadata-snapshot.js", () => ({
      getCurrentPluginMetadataSnapshot: () => undefined,
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
    const personal = (provider: string, choiceId: string) => ({
      provider,
      choiceId,
      method: "api-key",
      personalAccount: true,
    });
    const bundled = manifest("personal-provider", {
      providerAuthChoices: [
        personal("personal-provider", "personal-key"),
        { provider: "personal-provider", method: "host-import", choiceId: "host-import" },
      ],
    });
    const workspace = manifest("workspace-provider", {
      origin: "workspace",
      providerAuthChoices: [personal("workspace-provider", "workspace-key")],
    });
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
      const snapshot = registrySnapshot();
      indexLoader.mockReturnValue(snapshot);
      indexWithMetadataLoader.mockReturnValue({
        snapshot,
        source: "derived",
        diagnostics: [],
        manifestRegistry: prepared
          ? {
              plugins: [
                ...plugins,
                manifest("not-installed", {
                  providers: ["direct-provider"],
                  cliBackends: ["shared-cli"],
                }),
              ],
              diagnostics: [],
            }
          : undefined,
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
    setManifestPlugins([
      manifest("openai"),
      manifest("anthropic", { cliBackends: ["claude-cli"] }),
    ]);

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
    for (const loader of [
      runtimeLoader,
      setupLoader,
      metadataLoader,
      indexLoader,
      indexWithMetadataLoader,
    ]) {
      loader.mockReset();
    }
    indexLoader.mockImplementation(registrySnapshot);
    indexWithMetadataLoader.mockImplementation(() => ({
      snapshot: registrySnapshot(),
      source: "derived",
      diagnostics: [],
    }));
    const registry = providerRegistry("demo-provider", "Demo Provider", "google");
    runtimeLoader.mockReturnValue(registry);
    setupLoader.mockReturnValue(registry);
    manifestLoader.mockReset();
    setManifest("google", { enabledByDefault: true });
  });

  it("loads catalog augment hooks only for declarative runtime catalog manifests", () => {
    setManifestPlugins([
      manifest("static-bundled", {
        enabledByDefault: true,
        modelCatalog: { providers: { "static-bundled": { models: [{ id: "static-model" }] } } },
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

    const ids = owners.resolveExternalAuthProfileProviderPluginIds({ config: {}, env: {} });
    expect(ids).toEqual(["external-auth-owner"]);
    expect(runtimeLoader).not.toHaveBeenCalled();
  });

  it("treats explicit empty provider scopes as scoped-empty in provider helpers", () => {
    const query = { config: {}, env: {}, onlyPluginIds: [] };
    expect(owners.resolveEnabledProviderPluginIds(query)).toStrictEqual([]);
    expect(owners.resolveDiscoveredProviderPluginIds(query)).toStrictEqual([]);
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

    expect(runtimeLoader.mock.calls.at(-1)?.[0]).toMatchObject({
      workspaceDir: "/workspace/runtime",
      cache: true,
      activate: false,
    });
  });

  it.each([true, false])("loads setup.providers only when plugins are enabled: %s", (enabled) => {
    setManifest("setup-owned-provider", {
      providers: [],
      setup: {
        providers: [{ id: "setup-owned" }],
      },
    });

    resolvePluginProviders({
      config: enabled ? {} : { plugins: { enabled: false } },
      providerRefs: ["setup-owned"],
      activate: true,
      mode: "setup",
    });

    if (enabled) {
      expectActivatedOwner("setup-owned-provider", "setup", true);
    } else {
      expect(setupLoader).not.toHaveBeenCalled();
    }
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
      supported("openai", { modelPrefixes: ["gpt-"] }),
      supported("workspace-openai", { modelPrefixes: ["gpt-"] }, "workspace"),
    ]);

    expectOwners("gpt-5.4", ["workspace-openai"]);
  });

  it("rejects unsafe model patterns that would match the model", () => {
    setManifestPlugins([supported("malicious", { modelPatterns: ["(a+)+$"] })]);

    // An unguarded pattern would match and incorrectly claim the model.
    expectOwners("a", undefined);
  });

  it.each([
    {
      behavior: "preserves LM Studio @iq* quant suffixes",
      id: "lmstudio",
      label: "LM Studio",
      model: "qwen3.6-27b@iq3_xxs",
      plugins: [
        supported("lmstudio", { modelPatterns: ["^qwen3\\.6-27b@iq3_xxs$"] }),
        supported("workspace-prefix", { modelPrefixes: ["qwen3.6-27b@"] }, "workspace"),
      ],
    },
    {
      behavior: "auto-loads a same-id prefix after ambiguous pattern matches",
      id: "openai",
      label: "OpenAI",
      model: "gpt-5.4",
      plugins: [
        supported("openai", { modelPrefixes: ["gpt-", "o1", "o3", "o4"] }),
        ...["openai", "second-pattern"].map((id) =>
          supported(id, {
            modelPatterns: ["^gpt-"],
            modelPrefixes: ["gpt-"],
          }),
        ),
      ],
    },
  ])("$behavior when resolving model-owned providers", ({ id, label, model, plugins }) => {
    // Duplicate provider declarations must not duplicate ownership.
    if (id === "openai") {
      plugins[0].providers = [id, id];
    }
    setManifestPlugins(plugins);
    runtimeLoader.mockReturnValue(providerRegistry(id, label));
    if (id === "lmstudio") {
      expectOwners(model, [id]);
      expectOwners("qwen3.6-27b", undefined);
    }
    expect(resolvePluginProviders({ config: {}, modelRefs: [model] })).toEqual([
      { id, label, auth: [], pluginId: id },
    ]);
    expectActivatedOwner(id);
  });
});
