import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginCandidate } from "./discovery.js";
import {
  getPluginRecord,
  ensurePluginRegistryMigrated,
  inspectPluginRegistry,
  isPluginEnabled,
  listPluginContributionIds,
  listPluginRecords,
  loadPluginRegistrySnapshot,
  refreshPluginRegistry,
  resolveChannelOwners,
  resolveCliBackendOwners,
  resolvePluginContributionOwners,
  resolveProviderOwners,
  resolveSetupProviderOwners,
} from "./plugin-registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-registry", tempDirs);
}

function hermeticEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
    OPENCLAW_VERSION: "2026.4.25",
    VITEST: "true",
    ...overrides,
  };
}

function createCandidate(rootDir: string): PluginCandidate {
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while reading plugin registry');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "demo",
      name: "Demo",
      configSchema: { type: "object" },
      providers: ["demo"],
      channels: ["demo-chat"],
      cliBackends: ["demo-cli"],
      setup: {
        providers: [{ id: "demo-setup", envVars: ["DEMO_API_KEY"] }],
        cliBackends: ["demo-setup-cli"],
      },
      channelConfigs: {
        "demo-chat": {
          schema: { type: "object" },
        },
      },
      modelCatalog: {
        providers: {
          demo: {
            models: [{ id: "demo-model" }],
          },
        },
      },
      commandAliases: [{ name: "demo-command" }],
      contracts: {
        tools: ["demo-tool"],
      },
    }),
    "utf8",
  );
  return {
    idHint: "demo",
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin: "global",
  };
}

describe("plugin registry facade", () => {
  it("resolves cold plugin records and contribution owners without loading runtime", () => {
    const rootDir = makeTempDir();
    const candidate = createCandidate(rootDir);
    const index = loadPluginRegistrySnapshot({
      candidates: [candidate],
      env: hermeticEnv(),
    });

    expect(listPluginRecords({ index }).map((plugin) => plugin.pluginId)).toEqual(["demo"]);
    expect(getPluginRecord({ index, pluginId: "demo" })).toMatchObject({
      pluginId: "demo",
      enabled: true,
    });
    expect(isPluginEnabled({ index, pluginId: "demo" })).toBe(true);
    expect(listPluginContributionIds({ index, contribution: "providers" })).toEqual(["demo"]);
    expect(resolveProviderOwners({ index, providerId: "demo" })).toEqual(["demo"]);
    expect(resolveChannelOwners({ index, channelId: "demo-chat" })).toEqual(["demo"]);
    expect(resolveCliBackendOwners({ index, cliBackendId: "demo-cli" })).toEqual(["demo"]);
    expect(
      resolvePluginContributionOwners({
        index,
        contribution: "cliBackends",
        matches: (contributionId) => contributionId === "demo-cli",
      }),
    ).toEqual(["demo"]);
    expect(resolveSetupProviderOwners({ index, setupProviderId: "demo-setup" })).toEqual(["demo"]);
  });

  it("keeps disabled records inspectable while excluding owners by default", () => {
    const rootDir = makeTempDir();
    const candidate = createCandidate(rootDir);
    const index = loadPluginRegistrySnapshot({
      candidates: [candidate],
      config: {
        plugins: {
          entries: {
            demo: {
              enabled: false,
            },
          },
        },
      },
      env: hermeticEnv(),
    });

    expect(getPluginRecord({ index, pluginId: "demo" })).toMatchObject({
      pluginId: "demo",
      enabled: false,
    });
    const config = {
      plugins: {
        entries: {
          demo: {
            enabled: false,
          },
        },
      },
    };
    expect(isPluginEnabled({ index, pluginId: "demo", config })).toBe(false);
    expect(resolveProviderOwners({ index, providerId: "demo", config })).toEqual([]);
    expect(
      resolveProviderOwners({ index, providerId: "demo", config, includeDisabled: true }),
    ).toEqual(["demo"]);
  });

  it("exposes explicit persisted registry inspect and refresh operations", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);
    const env = hermeticEnv();

    await expect(
      inspectPluginRegistry({ stateDir, candidates: [candidate], env }),
    ).resolves.toMatchObject({
      state: "missing",
      refreshReasons: ["missing"],
      persisted: null,
      current: {
        plugins: [expect.objectContaining({ pluginId: "demo" })],
      },
    });

    await refreshPluginRegistry({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env,
    });

    await expect(
      inspectPluginRegistry({ stateDir, candidates: [candidate], env }),
    ).resolves.toMatchObject({
      state: "fresh",
      refreshReasons: [],
      persisted: {
        plugins: [expect.objectContaining({ pluginId: "demo" })],
      },
    });
  });

  it("migrates missing persisted registry state from legacy discovery inputs", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);
    const env = hermeticEnv();

    await expect(
      ensurePluginRegistryMigrated({ stateDir, candidates: [candidate], env }),
    ).resolves.toMatchObject({
      state: "missing",
      refreshReasons: ["missing"],
      migrated: true,
      current: {
        refreshReason: "migration",
        migrationVersion: 1,
        plugins: [expect.objectContaining({ pluginId: "demo", enabled: true })],
      },
    });

    await expect(
      inspectPluginRegistry({ stateDir, candidates: [candidate], env }),
    ).resolves.toMatchObject({
      state: "fresh",
      refreshReasons: [],
      persisted: {
        refreshReason: "migration",
        plugins: [expect.objectContaining({ pluginId: "demo" })],
      },
    });
  });
});
