import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { attachPluginInstallOwnerMigrations } from "./install-transaction.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const syncPluginsForUpdateChannelMock = vi.fn();
const updateNpmInstalledPluginsMock = vi.fn();
const loadInstalledPluginIndexMock = vi.fn();
const collectMissingPluginInstallPayloadsMock = vi.fn();

vi.mock("./update.js", () => ({
  syncPluginsForUpdateChannel: (...args: unknown[]) => syncPluginsForUpdateChannelMock(...args),
  updateNpmInstalledPlugins: (...args: unknown[]) => updateNpmInstalledPluginsMock(...args),
}));

vi.mock("./installed-plugin-index.js", () => ({
  loadInstalledPluginIndex: (...args: unknown[]) => loadInstalledPluginIndexMock(...args),
}));

vi.mock("./payload-verification.js", () => ({
  collectMissingPluginInstallPayloads: (...args: unknown[]) =>
    collectMissingPluginInstallPayloadsMock(...args),
}));

const { convergePluginReleaseCohort } = await import("./update-cohort.js");

function pluginRecord(params: {
  pluginId: string;
  installOwner: string;
  rootDir: string;
}): InstalledPluginIndexRecord {
  return recordInstalledPluginIndexInstallOwner(
    {
      pluginId: params.pluginId,
      manifestPath: `${params.rootDir}/openclaw.plugin.json`,
      manifestHash: params.pluginId,
      source: `${params.rootDir}/index.js`,
      rootDir: params.rootDir,
      origin: "global",
      enabled: true,
      startup: { sidecar: false, memory: false, agentHarnesses: [] },
      contributions: {
        channels: ["qqbot"],
        channelConfigs: [],
        providers: [],
        modelCatalogProviders: [],
        modelSupportPrefixes: [],
        modelSupportPatterns: [],
        autoEnableProviderIds: [],
        commandAliases: [],
        contracts: {},
      },
      compat: [],
    },
    params.installOwner,
  );
}

function installedIndex(params: {
  records: Record<string, PluginInstallRecord>;
  plugin?: InstalledPluginIndexRecord;
}): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 1,
    installRecords: params.records,
    plugins: params.plugin ? [params.plugin] : [],
    diagnostics: [],
  };
}

describe("plugin release cohort package reconciliation", () => {
  const tempDirs: string[] = [];
  afterEach(() => cleanupTrackedTempDirs(tempDirs));
  beforeEach(() => {
    vi.resetAllMocks();
    collectMissingPluginInstallPayloadsMock.mockResolvedValue([]);
    syncPluginsForUpdateChannelMock.mockImplementation(async ({ config }) => ({
      config,
      changed: false,
      summary: {
        switchedToBundled: [],
        switchedToClawHub: [],
        switchedToNpm: [],
        warnings: [],
        errors: [],
      },
    }));
  });

  it("keeps updates and payload verification active without initial install owners", async () => {
    const config = { plugins: { entries: { unrelated: { enabled: false } } } };
    const records = {
      introduced: {
        source: "npm",
        spec: "@example/introduced",
        installPath: "/plugins/introduced",
      },
    } satisfies Record<string, PluginInstallRecord>;
    const updatedConfig = { plugins: { ...config.plugins, installs: records } };
    const remaining = [
      { pluginId: "introduced", installPath: "/plugins/introduced", reason: "missing-package-dir" },
    ];
    // A valid empty index makes the old path fail on unwanted discovery, not a mock error.
    loadInstalledPluginIndexMock.mockReturnValue(installedIndex({ records: {} }));
    updateNpmInstalledPluginsMock.mockResolvedValue({
      config: updatedConfig,
      changed: true,
      outcomes: [],
    });
    collectMissingPluginInstallPayloadsMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(remaining);

    const result = await convergePluginReleaseCohort({
      config,
      channel: "stable",
      timeoutMs: 60_000,
    });

    expect(syncPluginsForUpdateChannelMock).toHaveBeenCalledOnce();
    expect(updateNpmInstalledPluginsMock).toHaveBeenCalledOnce();
    expect(collectMissingPluginInstallPayloadsMock).toHaveBeenCalledTimes(2);
    expect(collectMissingPluginInstallPayloadsMock).toHaveBeenNthCalledWith(2, {
      records,
      config: updatedConfig,
      skipDisabledPlugins: true,
      syncOfficialPluginInstalls: true,
      env: undefined,
    });
    expect(result.config).toEqual(updatedConfig);
    expect(result).toMatchObject({
      changed: true,
      npmChanged: true,
      remainingMissingPayloads: remaining,
    });
    expect(loadInstalledPluginIndexMock).not.toHaveBeenCalled();
  });

  it.each(["missing", "replaced", "replaced after sync introduces its owner"] as const)(
    "reconciles %s payloads against the new package metadata",
    async (state) => {
      const { loadInstalledPluginIndex } = await vi.importActual<
        typeof import("./installed-plugin-index.js")
      >("./installed-plugin-index.js");
      loadInstalledPluginIndexMock.mockImplementation(loadInstalledPluginIndex);
      const root = fs.realpathSync(makeTrackedTempDir("openclaw-cohort", tempDirs));
      const installPath = path.join(root, "package");
      const env = {
        ...process.env,
        HOME: root,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
      };
      const writePayload = (pluginId: string) => {
        fs.mkdirSync(installPath, { recursive: true });
        fs.writeFileSync(
          path.join(installPath, "package.json"),
          JSON.stringify({
            name: "@example/cohort",
            version: "1.0.0",
            openclaw: { extensions: ["./index.js"] },
          }),
        );
        fs.writeFileSync(
          path.join(installPath, "openclaw.plugin.json"),
          JSON.stringify({ id: pluginId, configSchema: { type: "object" } }),
        );
        fs.writeFileSync(path.join(installPath, "index.js"), "module.exports = {};\n");
      };
      if (state !== "missing") {
        writePayload("retired-child");
      }
      const records = {
        cohort: { source: "npm", spec: "@example/cohort", installPath },
      } satisfies Record<string, PluginInstallRecord>;
      const config = {
        plugins: {
          installs: records,
          entries: { "retired-child": { enabled: true }, unrelated: { enabled: false } },
        },
      } satisfies OpenClawConfig;
      if (state === "missing") {
        collectMissingPluginInstallPayloadsMock.mockResolvedValueOnce([
          { pluginId: "cohort", installPath, reason: "missing-package-dir" },
        ]);
      }
      updateNpmInstalledPluginsMock.mockImplementation(async ({ config: current }) => {
        writePayload("current-child");
        return {
          config: {
            ...current,
            plugins: {
              ...current.plugins,
              installs: { cohort: { ...records.cohort, version: "1.0.0" } },
            },
          },
          changed: true,
          outcomes: [],
        };
      });

      if (state === "replaced after sync introduces its owner") {
        syncPluginsForUpdateChannelMock.mockResolvedValueOnce({
          config,
          changed: true,
          summary: {
            switchedToBundled: [],
            switchedToClawHub: [],
            switchedToNpm: [],
            warnings: [],
            errors: [],
          },
        });
      }
      const inputConfig =
        state === "replaced after sync introduces its owner"
          ? { ...config, plugins: { ...config.plugins, installs: {} } }
          : config;
      const result = await withPluginCache(createPluginCache(), () =>
        convergePluginReleaseCohort({
          config: inputConfig,
          channel: "stable",
          timeoutMs: 60_000,
          env,
        }),
      );

      expect(result.config.plugins?.entries?.unrelated).toEqual({ enabled: false });
      if (state !== "missing") {
        expect(result.config.plugins?.entries).not.toHaveProperty("retired-child");
      }
      expect(result.config.plugins?.installs?.cohort?.version).toBe("1.0.0");
    },
  );

  it("removes the legacy load path after a successful post-core owner migration", async () => {
    const legacyRoot = "/plugins/qqbot-legacy";
    const canonicalRoot = "/plugins/openclaw-qqbot";
    const legacyRecords = {
      qqbot: {
        source: "npm",
        spec: "@openclaw/qqbot@1.9.0",
        installPath: legacyRoot,
      },
      "openclaw-qqbot": {
        source: "npm",
        spec: "@tencent-connect/openclaw-qqbot@2.0.1",
        installPath: canonicalRoot,
      },
    } satisfies Record<string, PluginInstallRecord>;
    const canonicalRecords = {
      "openclaw-qqbot": {
        source: "npm",
        spec: "@tencent-connect/openclaw-qqbot@2.0.3",
        installPath: canonicalRoot,
      },
    } satisfies Record<string, PluginInstallRecord>;
    const config = {
      channels: { qqbot: { enabled: true, appId: "app", clientSecret: "secret" } },
      plugins: {
        load: { paths: [legacyRoot, `${legacyRoot}/index.js`, "/plugins/unrelated.js"] },
        installs: legacyRecords,
      },
    } satisfies OpenClawConfig;
    const updatedConfig = {
      ...config,
      plugins: { ...config.plugins, installs: canonicalRecords },
    } satisfies OpenClawConfig;
    loadInstalledPluginIndexMock
      .mockReturnValueOnce(
        installedIndex({
          records: legacyRecords,
          plugin: pluginRecord({ pluginId: "qqbot", installOwner: "qqbot", rootDir: legacyRoot }),
        }),
      )
      .mockReturnValueOnce(
        installedIndex({
          records: canonicalRecords,
          plugin: pluginRecord({
            pluginId: "openclaw-qqbot",
            installOwner: "openclaw-qqbot",
            rootDir: canonicalRoot,
          }),
        }),
      );
    updateNpmInstalledPluginsMock.mockResolvedValueOnce(
      attachPluginInstallOwnerMigrations(
        { config: updatedConfig, changed: true, outcomes: [] },
        { qqbot: "openclaw-qqbot" },
      ),
    );

    const result = await convergePluginReleaseCohort({
      config,
      channel: "stable",
      timeoutMs: 60_000,
    });

    expect(result.changed).toBe(true);
    expect(result.config.channels?.qqbot).toEqual(config.channels.qqbot);
    expect(result.config.plugins?.installs).toEqual(canonicalRecords);
    expect(result.config.plugins?.load?.paths).toEqual(["/plugins/unrelated.js"]);
  });
});
