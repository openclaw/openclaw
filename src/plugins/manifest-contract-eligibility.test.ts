import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "./config-state.js";

const mocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
  readBundledDiscoveryMode: vi.fn<() => "compat" | "allowlist" | undefined>(() => "allowlist"),
}));

vi.mock("./bundled-discovery-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bundled-discovery-state.js")>();
  return {
    ...actual,
    readBundledDiscoveryMode: mocks.readBundledDiscoveryMode,
    readBundledDiscoveryModeMemoized: (env?: NodeJS.ProcessEnv) =>
      actual.readBundledDiscoveryModeMemoized(env, {}, mocks.readBundledDiscoveryMode),
  };
});

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

type Eligibility = typeof import("./manifest-contract-eligibility.js");
let isAvailable: Eligibility["isManifestPluginAvailableForControlPlane"];
let listPlugins: Eligibility["listAvailableManifestContractPlugins"];
let listValues: Eligibility["listAvailableManifestContractValues"];
let loadSnapshot: Eligibility["loadManifestContractSnapshot"];
let clearPluginMetadataLifecycleCaches: typeof import("./plugin-metadata-lifecycle.js").clearPluginMetadataLifecycleCaches;
let makePluginMetadataIndex: typeof import("./current-plugin-metadata.test-support.js").makePluginMetadataIndex;
let makePluginMetadataManifestRegistry: typeof import("./current-plugin-metadata.test-support.js").makePluginMetadataManifestRegistry;
let createInstalledPluginEnabledPredicate: typeof import("./installed-plugin-index.js").createInstalledPluginEnabledPredicate;

beforeAll(async () => {
  // The plugins project shares module state across files. Rebind this module graph
  // after the hoisted mocks so an earlier production import cannot bypass them.
  vi.resetModules();
  ({
    isManifestPluginAvailableForControlPlane: isAvailable,
    listAvailableManifestContractPlugins: listPlugins,
    listAvailableManifestContractValues: listValues,
    loadManifestContractSnapshot: loadSnapshot,
  } = await import("./manifest-contract-eligibility.js"));
  ({ clearPluginMetadataLifecycleCaches } = await import("./plugin-metadata-lifecycle.js"));
  ({ makePluginMetadataIndex, makePluginMetadataManifestRegistry } =
    await import("./current-plugin-metadata.test-support.js"));
  ({ createInstalledPluginEnabledPredicate } = await import("./installed-plugin-index.js"));
});

describe("bundled manifest contract availability", () => {
  const plugin = {
    id: "google",
    origin: "bundled" as const,
    contracts: { imageGenerationProviders: ["google"] },
  };
  const index = { plugins: [{ pluginId: "google", origin: "bundled", enabled: false }] };
  const snapshot = {
    index,
    plugins: [plugin],
  } as never;
  const available = (params: Partial<Parameters<typeof isAvailable>[0]>) =>
    isAvailable({ snapshot, plugin, ...params });
  const values = (config: OpenClawConfig) =>
    listValues({ snapshot, contract: "imageGenerationProviders", config });

  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    mocks.readBundledDiscoveryMode.mockReset();
    mocks.readBundledDiscoveryMode.mockReturnValue("allowlist");
  });

  it.each(["allowlist", "compat"] as const)(
    "honors %s discovery for provider contracts",
    (mode) => {
      mocks.readBundledDiscoveryMode.mockReturnValue(mode);
      const config = { plugins: { allow: ["another-plugin"] } };
      expect(available({ config, allowBundledProviderCompat: true })).toBe(mode === "compat");
      expect(values(config)).toEqual(mode === "compat" ? ["google"] : []);
    },
  );

  it.each([
    ["custom-owner", "private-channel", { enabled: true }, true],
    ["discord-owner", "discord", { enabled: false, token: "configured" }, false],
  ] satisfies Array<[string, string, { enabled?: boolean; token?: string }, boolean]>)(
    "honors %s / %s: channel=%j -> %s",
    (id, channel, config, expected) => {
      expect(
        available({
          plugin: { ...plugin, id, channels: [channel] },
          config: {
            plugins: { allow: ["another-plugin"] },
            channels: { [channel]: config },
          },
        }),
      ).toBe(expected);
      if (expected) {
        expect(mocks.readBundledDiscoveryMode).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves globally disabled bundled metadata for the named speech compatibility path", () => {
    const config = { plugins: { enabled: false } };
    const normalizedConfig = normalizePluginsConfig(config.plugins);
    expect(available({ config, normalizedConfig })).toBe(true);
    expect(values(config)).toEqual(["google"]);
    expect(normalizedConfig.enabled).toBe(false);
  });

  it.each([{ entries: { google: { enabled: false } } }, { deny: ["google"] }])(
    "never bypasses explicit owner prohibition in bundled compatibility mode",
    (plugins) => {
      mocks.readBundledDiscoveryMode.mockReturnValue("compat");

      expect(
        available({
          plugin: { ...plugin, channels: ["discord"] },
          config: {
            plugins: { allow: ["another-plugin"], ...plugins },
            channels: { discord: { token: "configured" } },
          },
          allowBundledProviderCompat: true,
        }),
      ).toBe(false);
    },
  );

  it("keeps non-provider manifest contracts behind the allowlist", () => {
    mocks.readBundledDiscoveryMode.mockReturnValue("compat");
    const nonProviderPlugin = {
      ...plugin,
      contracts: { documentExtractors: ["document"] },
    };
    expect(
      listValues({
        snapshot: { index, plugins: [nonProviderPlugin] } as never,
        contract: "documentExtractors",
        config: { plugins: { allow: ["another-plugin"] } },
      }),
    ).toEqual([]);
  });
});

describe("prepared installed-plugin eligibility", () => {
  it.each([
    { config: undefined, expected: [true, true, true, false, false, false] },
    { config: {}, expected: [true, true, false, true, false, false] },
    {
      config: { plugins: { enabled: false } },
      expected: [true, false, false, false, false, false],
    },
    {
      config: { plugins: { allow: ["global", "workspace", "duplicate"] } },
      expected: [false, true, true, false, true, false],
    },
    {
      config: {
        plugins: {
          allow: ["global", "workspace", "duplicate"],
          deny: ["workspace"],
          entries: { global: { enabled: false } },
        },
      },
      expected: [false, false, false, false, true, false],
    },
  ])("preserves policy and first-record selection for $config", ({ config, expected }) => {
    clearPluginMetadataLifecycleCaches();
    mocks.readBundledDiscoveryMode.mockReturnValue("allowlist");
    const index = makePluginMetadataIndex();
    const records = (id: string, overrides: Partial<(typeof index.plugins)[number]> = {}) =>
      makePluginMetadataIndex(id).plugins.map((record) => Object.assign({}, record, overrides));
    index.plugins = [
      ...records("provider", {
        origin: "bundled" as const,
        enabledByDefault: true,
        contributions: {
          channels: [],
          channelConfigs: [],
          providers: ["provider"],
          modelCatalogProviders: [],
          modelSupportPrefixes: [],
          modelSupportPatterns: [],
          autoEnableProviderIds: [],
          commandAliases: [],
          contracts: {},
        },
      }),
      ...records("global"),
      ...records("workspace", { origin: "workspace" }),
      ...records("disabled", { enabled: false }),
      ...records("duplicate", { origin: "workspace", enabled: false }),
      ...records("duplicate"),
    ];
    const plugins = index.plugins.slice(0, 5).map((record) => ({
      id: record.pluginId,
      origin: record.origin,
    }));
    plugins.push({ id: "missing", origin: "global" });
    const isInstalledPluginEnabled = createInstalledPluginEnabledPredicate(index.plugins, config);
    const params = {
      snapshot: { index },
      config,
      normalizedConfig: normalizePluginsConfig(config?.plugins),
    };
    expect(plugins.map((plugin) => isAvailable({ ...params, plugin }))).toEqual(expected);
    expect(
      plugins.map((plugin) =>
        isAvailable({
          ...params,
          plugin,
          isInstalledPluginEnabled,
        }),
      ),
    ).toEqual(expected);
    const manifestPlugins = plugins.flatMap(({ id, origin }) =>
      makePluginMetadataManifestRegistry(id).plugins.map((plugin) =>
        Object.assign({}, plugin, { origin, contracts: { imageGenerationProviders: [id] } }),
      ),
    );
    const expectedPlugins = manifestPlugins.filter((_plugin, position) => expected[position]);
    const available = listPlugins({
      snapshot: { index, plugins: manifestPlugins },
      config,
      contract: "imageGenerationProviders",
    });
    expect(available).toHaveLength(expectedPlugins.length);
    available.forEach((plugin, position) => expect(plugin).toBe(expectedPlugins[position]));
  });
});

describe("loadManifestContractSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      plugins: [],
      byPluginId: new Map(),
    });
    mocks.resolvePluginMetadataSnapshot.mockImplementation(
      (params?: Parameters<typeof mocks.loadPluginMetadataSnapshot>[0]) =>
        mocks.loadPluginMetadataSnapshot(params),
    );
  });

  it.each([false, true])(
    "resolves scoped or default-discovery metadata (configless=%s)",
    (configless) => {
      const env = { HOME: configless ? "/home/default-config" : "/home/snapshot" };
      const plugins = configless ? [{ id: "demo" }] : [];
      const snapshot = {
        index: { plugins: plugins.map(({ id }) => ({ pluginId: id })) },
        plugins,
        byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
      };
      const reader = configless
        ? mocks.loadPluginMetadataSnapshot
        : mocks.resolvePluginMetadataSnapshot;
      reader.mockReturnValue(snapshot);
      const request = configless ? { env } : { config: {}, workspaceDir: "/workspace", env };
      expect(loadSnapshot(request)).toEqual(snapshot);
      const expected = { config: undefined, ...request, allowWorkspaceScopedCurrent: configless };
      expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith(expected);
      if (configless) {
        expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledWith(expected);
      } else {
        expect(mocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
      }
    },
  );
});
