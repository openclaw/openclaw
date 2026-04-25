import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginCandidate } from "../../../plugins/discovery.js";
import {
  readPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndex,
} from "../../../plugins/installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "../../../plugins/installed-plugin-index.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
} from "../../../plugins/test-helpers/fs-fixtures.js";
import {
  DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV,
  FORCE_PLUGIN_REGISTRY_MIGRATION_ENV,
  migratePluginRegistryForInstall,
  preflightPluginRegistryInstallMigration,
} from "./plugin-registry-migration.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-registry-migration", tempDirs);
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

function createCandidate(
  rootDir: string,
  id = "demo",
  origin: PluginCandidate["origin"] = "global",
): PluginCandidate {
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while migrating plugin registry');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      name: id,
      configSchema: { type: "object" },
      providers: [id],
    }),
    "utf8",
  );
  return {
    idHint: id,
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin,
  };
}

function createCurrentIndex(): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 2,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    plugins: [],
    diagnostics: [],
  };
}

describe("plugin registry install migration", () => {
  it("short-circuits when a current registry file already exists", async () => {
    const stateDir = makeTempDir();
    const filePath = path.join(stateDir, "plugins", "installed-index.json");
    await writePersistedInstalledPluginIndex(createCurrentIndex(), { stateDir });
    const readConfig = vi.fn(async () => ({}));

    await expect(
      migratePluginRegistryForInstall({
        stateDir,
        readConfig,
        env: hermeticEnv(),
      }),
    ).resolves.toMatchObject({
      status: "skip-existing",
      migrated: false,
      preflight: {
        action: "skip-existing",
        filePath,
      },
    });
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("migrates when an existing registry file is not current", async () => {
    const stateDir = makeTempDir();
    const filePath = path.join(stateDir, "plugins", "installed-index.json");
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, migrationVersion: 1 }), "utf8");

    await expect(
      migratePluginRegistryForInstall({
        stateDir,
        candidates: [createCandidate(pluginDir)],
        readConfig: async () => ({}),
        env: hermeticEnv(),
      }),
    ).resolves.toMatchObject({
      status: "migrated",
      preflight: {
        action: "migrate",
      },
    });

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject({
      migrationVersion: 2,
      plugins: [expect.objectContaining({ pluginId: "demo" })],
    });
  });

  it("persists migration-relevant plugin records without dropping explicit disabled state", async () => {
    const stateDir = makeTempDir();
    const enabledDir = path.join(stateDir, "plugins", "enabled-demo");
    const disabledDir = path.join(stateDir, "plugins", "disabled-demo");
    const unusedBundledDir = path.join(stateDir, "plugins", "unused-bundled");
    fs.mkdirSync(enabledDir, { recursive: true });
    fs.mkdirSync(disabledDir, { recursive: true });
    fs.mkdirSync(unusedBundledDir, { recursive: true });

    await expect(
      migratePluginRegistryForInstall({
        stateDir,
        candidates: [
          createCandidate(enabledDir, "enabled-demo"),
          createCandidate(disabledDir, "disabled-demo", "bundled"),
          createCandidate(unusedBundledDir, "unused-bundled", "bundled"),
        ],
        readConfig: async () => ({
          plugins: {
            entries: {
              "disabled-demo": {
                enabled: false,
              },
            },
          },
        }),
        env: hermeticEnv(),
      }),
    ).resolves.toMatchObject({
      status: "migrated",
      current: {
        plugins: [
          expect.objectContaining({ pluginId: "enabled-demo", enabled: true }),
          expect.objectContaining({ pluginId: "disabled-demo", enabled: false }),
        ],
      },
    });

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject({
      plugins: [
        expect.objectContaining({ pluginId: "enabled-demo", enabled: true }),
        expect.objectContaining({ pluginId: "disabled-demo", enabled: false }),
      ],
    });
    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    expect(persisted?.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "enabled-demo",
      "disabled-demo",
    ]);
  });

  it("supports dry-run preflight without reading config or writing the registry", async () => {
    const stateDir = makeTempDir();
    const readConfig = vi.fn(async () => ({}));

    await expect(
      migratePluginRegistryForInstall({
        stateDir,
        dryRun: true,
        readConfig,
        env: hermeticEnv(),
      }),
    ).resolves.toMatchObject({
      status: "dry-run",
      migrated: false,
      preflight: {
        action: "migrate",
      },
    });
    expect(readConfig).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(stateDir, "plugins", "installed-index.json"))).toBe(false);
  });

  it("migrates missing registry state from legacy discovery and config inputs", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);

    await expect(
      migratePluginRegistryForInstall({
        stateDir,
        candidates: [candidate],
        readConfig: async () => ({
          plugins: {
            installs: {
              demo: {
                source: "npm",
                resolvedName: "@vendor/demo",
                resolvedVersion: "1.0.0",
              },
            },
          },
        }),
        env: hermeticEnv(),
      }),
    ).resolves.toMatchObject({
      status: "migrated",
      migrated: true,
      current: {
        refreshReason: "migration",
        migrationVersion: 2,
        plugins: [
          expect.objectContaining({
            pluginId: "demo",
            installRecord: expect.objectContaining({
              source: "npm",
              resolvedName: "@vendor/demo",
              resolvedVersion: "1.0.0",
            }),
          }),
        ],
      },
    });

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject({
      refreshReason: "migration",
      plugins: [expect.objectContaining({ pluginId: "demo" })],
    });
  });

  it("marks force migration env as deprecated break-glass", () => {
    expect(
      preflightPluginRegistryInstallMigration({
        stateDir: makeTempDir(),
        env: hermeticEnv({
          [FORCE_PLUGIN_REGISTRY_MIGRATION_ENV]: "1",
        }),
      }),
    ).toMatchObject({
      action: "migrate",
      force: true,
      deprecationWarnings: [
        expect.stringContaining(`${FORCE_PLUGIN_REGISTRY_MIGRATION_ENV} is deprecated`),
      ],
    });
  });

  it("treats falsey env flag strings as unset", async () => {
    const stateDir = makeTempDir();
    await writePersistedInstalledPluginIndex(createCurrentIndex(), { stateDir });

    expect(
      preflightPluginRegistryInstallMigration({
        stateDir,
        env: hermeticEnv({
          [DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV]: "0",
          [FORCE_PLUGIN_REGISTRY_MIGRATION_ENV]: "false",
        }),
      }),
    ).toMatchObject({
      action: "skip-existing",
      force: false,
      deprecationWarnings: [],
    });
  });
});
