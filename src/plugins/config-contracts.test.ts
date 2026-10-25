import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";

const mocks = vi.hoisted(() => {
  const loadManifestRegistry = vi.fn();
  return {
    discoverOpenClawPlugins: vi.fn(() => ({ candidates: [], diagnostics: [] })),
    findBundledPluginMetadataById: vi.fn(),
    loadBundledManifestRegistry: vi.fn(),
    loadPluginManifestRegistryForInstalledIndex: loadManifestRegistry,
    loadPluginManifestRegistryForPluginRegistry: loadManifestRegistry,
    loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
  };
});

vi.mock("./discovery.js", () => ({
  discoverOpenClawPlugins: mocks.discoverOpenClawPlugins,
}));

vi.mock("./bundled-plugin-metadata.js", () => ({
  findBundledPluginMetadataById: mocks.findBundledPluginMetadataById,
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: mocks.loadBundledManifestRegistry,
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: mocks.loadPluginManifestRegistryForInstalledIndex,
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: mocks.loadPluginManifestRegistryForPluginRegistry,
  loadPluginRegistrySnapshot: mocks.loadPluginRegistrySnapshot,
}));

import {
  collectPluginConfigContractMatches,
  resolvePluginConfigContractsById,
} from "./config-contracts.js";

type ConfigContracts = NonNullable<PluginManifestRegistry["plugins"][number]["configContracts"]>;

function createRegistry(
  id?: string,
  origin: "config" | "bundled" = "bundled",
  configContracts?: ConfigContracts,
): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: id ? [createPluginManifestRecordFixture({ id, origin, configContracts })] : [],
  };
}

const tokenContract = {
  secretInputs: { paths: [{ path: "credentials.token", expected: "string" as const }] },
};
const twilioPath = { path: "twilio.authToken", expected: "string" as const };
const realtimePath = { path: "realtime.providers.*.apiKey", expected: "string" as const };

function expectContracts(
  params: Parameters<typeof resolvePluginConfigContractsById>[0],
  id: string,
  origin: "config" | "bundled",
  configContracts: ConfigContracts,
) {
  expect(resolvePluginConfigContractsById(params)).toEqual(
    new Map([[id, { origin, configContracts }]]),
  );
}

describe("resolvePluginConfigContractsById", () => {
  beforeEach(() => {
    mocks.discoverOpenClawPlugins.mockReset().mockReturnValue({ candidates: [], diagnostics: [] });
    mocks.findBundledPluginMetadataById.mockReset();
    mocks.loadBundledManifestRegistry.mockReset().mockReturnValue(createRegistry());
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReset().mockReturnValue(createRegistry());
    mocks.loadPluginRegistrySnapshot.mockReset().mockReturnValue({ plugins: [] });
  });

  it("uses a supplied manifest registry as the authoritative contract source", () => {
    const manifestRegistry = createRegistry("prepared-plugin", "config", tokenContract);

    expectContracts(
      {
        pluginIds: ["prepared-plugin"],
        manifestRegistry,
        fallbackToBundledMetadataForResolvedBundled: true,
        fallbackBundledPluginIds: ["prepared-plugin"],
      },
      "prepared-plugin",
      "config",
      tokenContract,
    );
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).not.toHaveBeenCalled();
    expect(mocks.discoverOpenClawPlugins).not.toHaveBeenCalled();
    expect(mocks.loadBundledManifestRegistry).not.toHaveBeenCalled();
    expect(mocks.findBundledPluginMetadataById).not.toHaveBeenCalled();
  });

  it("does not fall back to bundled registry when registry already resolved a plugin without config contracts", () => {
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createRegistry("brave", "bundled"),
    );

    expect(
      resolvePluginConfigContractsById({
        pluginIds: ["brave"],
      }),
    ).toEqual(new Map());
    expect(mocks.loadBundledManifestRegistry).not.toHaveBeenCalled();
  });

  const migration = { compatibilityMigrationPaths: ["plugins.entries.voice-call.config"] };
  it.each([
    { source: "supplied bundled registry", supplied: true, origin: "bundled", stale: false },
    { source: "stale bundled SecretInputs", supplied: false, origin: "bundled", stale: true },
    { source: "runtime bundled discovery", supplied: false, origin: "config", stale: false },
  ] as const)("hydrates contracts from $source", ({ supplied, origin, stale }) => {
    const id = "voice-call";
    const contracts = { secretInputs: { paths: [twilioPath, realtimePath] } };
    const registry = createRegistry(
      id,
      origin,
      stale ? { ...migration, secretInputs: { paths: [twilioPath] } } : undefined,
    );
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(registry);
    mocks.loadBundledManifestRegistry.mockReturnValue(createRegistry(id, "bundled", contracts));
    expectContracts(
      {
        pluginIds: [id],
        ...(supplied ? { manifestRegistry: registry } : {}),
        fallbackToBundledMetadataForResolvedBundled: origin === "bundled",
        ...(!stale ? { fallbackBundledPluginIds: [id] } : {}),
      },
      id,
      "bundled",
      stale ? { ...migration, ...contracts } : contracts,
    );
  });
});

describe("collectPluginConfigContractMatches", () => {
  const matches = (root: unknown, pathPattern: string) =>
    collectPluginConfigContractMatches({ root, pathPattern });
  it("only accepts canonical array index path segments", () => {
    const root = { items: ["first", "second"] };

    expect(matches(root, "items.1")).toEqual([
      { path: "items[1]", value: "second", parent: root.items, key: "1" },
    ]);
    expect(matches(root, "items.1.5")).toEqual([]);
    expect(matches(root, "items.01")).toEqual([]);
  });

  it("preserves exact dotted wildcard keys and array-index parents", () => {
    const headers = { "X.Trace": "trace-value" };
    const entries = [{ headers }];

    expect(matches({ "sales.eu": { entries } }, "*.entries.*.headers.*")).toEqual([
      {
        path: '["sales.eu"].entries[0].headers["X.Trace"]',
        value: "trace-value",
        parent: headers,
        key: "X.Trace",
      },
    ]);
    expect(matches({ entries }, "entries.*")).toEqual([
      { path: "entries[0]", value: entries[0], parent: entries, key: "0" },
    ]);
  });

  it("rejects array indexes outside canonical config path bounds", () => {
    const items = Array<string>(100_002);
    items[100_001] = "too far";

    expect(matches({ items }, "items.100001")).toEqual([]);
  });
});
