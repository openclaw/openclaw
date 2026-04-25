import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginCandidate } from "./discovery.js";
import {
  readPersistedInstalledPluginIndex,
  refreshPersistedInstalledPluginIndex,
  resolveInstalledPluginIndexStorePath,
  writePersistedInstalledPluginIndex,
} from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-installed-plugin-index-store", tempDirs);
}

function createIndex(overrides: Partial<InstalledPluginIndex> = {}): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    generatedAt: "2026-04-25T12:00:00.000Z",
    plugins: [
      {
        pluginId: "demo",
        manifestPath: "/plugins/demo/openclaw.plugin.json",
        manifestHash: "manifest-hash",
        rootDir: "/plugins/demo",
        origin: "global",
        enabled: true,
        contributions: {
          providers: ["demo"],
          channels: ["demo-chat"],
          channelConfigs: ["demo-chat"],
          setupProviders: [],
          cliBackends: [],
          modelCatalogProviders: [],
          commandAliases: [],
          contracts: [],
        },
        compat: [],
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

function createCandidate(rootDir: string): PluginCandidate {
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while persisting installed plugin index');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "demo",
      name: "Demo",
      configSchema: { type: "object" },
      providers: ["demo"],
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

describe("installed plugin index persistence", () => {
  it("resolves the persisted index path under the state plugins directory", () => {
    const stateDir = makeTempDir();

    expect(resolveInstalledPluginIndexStorePath({ stateDir })).toBe(
      path.join(stateDir, "plugins", "installed-index.json"),
    );
  });

  it("writes and reads the installed plugin index atomically", async () => {
    const stateDir = makeTempDir();
    const filePath = resolveInstalledPluginIndexStorePath({ stateDir });
    const index = createIndex();

    await expect(writePersistedInstalledPluginIndex(index, { stateDir })).resolves.toBe(filePath);

    expect(fs.readFileSync(filePath, "utf8")).toContain('"pluginId": "demo"');
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toEqual(index);
  });

  it("returns null for missing or invalid persisted indexes", async () => {
    const stateDir = makeTempDir();
    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toBeNull();

    const filePath = resolveInstalledPluginIndexStorePath({ stateDir });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 999 }), "utf8");

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toBeNull();
  });

  it("refreshes and persists a rebuilt index without loading plugin runtime", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);

    const index = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
        OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
    });

    expect(index.refreshReason).toBe("manual");
    expect(index.plugins.map((plugin) => plugin.pluginId)).toEqual(["demo"]);
    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject({
      refreshReason: "manual",
      plugins: [expect.objectContaining({ pluginId: "demo" })],
    });
  });
});
