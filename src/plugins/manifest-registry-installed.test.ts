import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-installed-manifest-registry", tempDirs);
}

function writePlugin(rootDir: string, pluginId: string, modelPrefix: string) {
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while reading manifests');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      configSchema: { type: "object" },
      providers: [pluginId],
      modelSupport: {
        modelPrefixes: [modelPrefix],
      },
    }),
    "utf8",
  );
}

function createIndex(rootDir: string): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    installRecords: {},
    plugins: [
      {
        pluginId: "installed",
        manifestPath: path.join(rootDir, "openclaw.plugin.json"),
        manifestHash: "manifest-hash",
        source: path.join(rootDir, "index.ts"),
        rootDir,
        origin: "global",
        enabled: true,
        startup: {
          sidecar: false,
          memory: false,
          deferConfiguredChannelFullLoadUntilAfterListen: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
    diagnostics: [],
  };
}

describe("loadPluginManifestRegistryForInstalledIndex", () => {
  it("loads manifest metadata only for plugins present in the installed index", () => {
    const installedRoot = makeTempDir();
    const unrelatedRoot = makeTempDir();
    writePlugin(installedRoot, "installed", "installed-");
    writePlugin(unrelatedRoot, "unrelated", "unrelated-");

    const registry = loadPluginManifestRegistryForInstalledIndex({
      index: createIndex(installedRoot),
      env: {
        OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
        OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
      includeDisabled: true,
    });

    expect(registry.plugins.map((plugin) => plugin.id)).toEqual(["installed"]);
    expect(registry.plugins[0]?.modelSupport).toEqual({
      modelPrefixes: ["installed-"],
    });
  });
});
