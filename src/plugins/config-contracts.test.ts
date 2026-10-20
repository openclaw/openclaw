// Covers plugin config contract validation and ownership boundaries.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "./manifest-registry.js";

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
    plugins: id
      ? [
          {
            id,
            origin,
            configContracts,
            rootDir: `/tmp/${id}`,
            manifestPath: `/tmp/${id}/openclaw.plugin.json`,
            source: `/tmp/${id}/openclaw.plugin.json`,
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
          },
        ]
      : [],
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
        fallbackToBundledMetadata: true,
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

  it("hydrates supplied bundled registry records from explicit bundled discovery", () => {
    mocks.loadBundledManifestRegistry.mockReturnValue(
      createRegistry("prepared-plugin", "bundled", tokenContract),
    );

    expectContracts(
      {
        pluginIds: ["prepared-plugin"],
        manifestRegistry: createRegistry("prepared-plugin", "bundled"),
        fallbackToBundledMetadata: true,
        fallbackToBundledMetadataForResolvedBundled: true,
        fallbackBundledPluginIds: ["prepared-plugin"],
      },
      "prepared-plugin",
      "bundled",
      tokenContract,
    );
  });

  it("refreshes stale bundled SecretInput contracts from bundled registry", () => {
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createRegistry("voice-call", "bundled", {
        compatibilityMigrationPaths: ["plugins.entries.voice-call.config"],
        secretInputs: {
          paths: [twilioPath],
        },
      }),
    );
    mocks.loadBundledManifestRegistry.mockReturnValue(
      createRegistry("voice-call", "bundled", {
        secretInputs: {
          paths: [twilioPath, realtimePath],
        },
      }),
    );

    expectContracts(
      {
        pluginIds: ["voice-call"],
        fallbackToBundledMetadataForResolvedBundled: true,
      },
      "voice-call",
      "bundled",
      {
        compatibilityMigrationPaths: ["plugins.entries.voice-call.config"],
        secretInputs: { paths: [twilioPath, realtimePath] },
      },
    );
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledTimes(1);
    expect(mocks.loadBundledManifestRegistry).toHaveBeenCalledTimes(1);
  });

  it("can hydrate missing contracts for plugin ids known to be bundled by runtime discovery", () => {
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createRegistry("voice-call", "config"),
    );
    mocks.loadBundledManifestRegistry.mockReturnValue(
      createRegistry("voice-call", "bundled", {
        secretInputs: {
          paths: [{ path: "tts.providers.*.apiKey", expected: "string" }],
        },
      }),
    );

    expectContracts(
      {
        pluginIds: ["voice-call"],
        fallbackBundledPluginIds: ["voice-call"],
      },
      "voice-call",
      "bundled",
      {
        secretInputs: { paths: [{ path: "tts.providers.*.apiKey", expected: "string" }] },
      },
    );
  });

  it("can skip bundled metadata fallback for registry-scoped callers", () => {
    expect(
      resolvePluginConfigContractsById({
        pluginIds: ["missing"],
        fallbackToBundledMetadata: false,
      }),
    ).toEqual(new Map());
    expect(mocks.loadBundledManifestRegistry).not.toHaveBeenCalled();
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
