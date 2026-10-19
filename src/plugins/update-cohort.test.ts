import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import * as bundledSources from "./bundled-sources.js";
import { attachPluginInstallOwnerMigrations } from "./install-transaction.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import * as cohort from "./update-cohort.test-support.js";

const syncPluginsForUpdateChannelMock = vi.fn();
const updateNpmInstalledPluginsMock = vi.fn();
const loadInstalledPluginIndexMock = vi.fn();
const collectMissingPluginInstallPayloadsMock = vi.fn();

vi.mock("./update.js", () => ({
  syncPluginsForUpdateChannel: (...args: unknown[]) => syncPluginsForUpdateChannelMock(...args),
  updateNpmInstalledPlugins: (...args: unknown[]) => updateNpmInstalledPluginsMock(...args),
}));

vi.mock("./installed-plugin-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index.js")>()),
  loadInstalledPluginIndex: (...args: unknown[]) => loadInstalledPluginIndexMock(...args),
}));

vi.mock("./payload-verification.js", () => ({
  collectMissingPluginInstallPayloads: (...args: unknown[]) =>
    collectMissingPluginInstallPayloadsMock(...args),
}));

const { convergePluginReleaseCohort } = await import("./update-cohort.js");

const summary = {
  switchedToBundled: [],
  switchedToClawHub: [],
  switchedToNpm: [],
  warnings: [],
  errors: [],
};
function npmRecord(spec: string, installPath: string) {
  return { source: "npm", spec, installPath } satisfies PluginInstallRecord;
}
function converge(
  params: Omit<Parameters<typeof convergePluginReleaseCohort>[0], "channel" | "timeoutMs">,
) {
  return convergePluginReleaseCohort({ channel: "stable", timeoutMs: 60_000, ...params });
}

function pluginRecord(pluginId: string, rootDir: string): InstalledPluginIndexRecord {
  const { index } = createPluginMetadataSnapshotFixture({
    plugins: [{ id: pluginId, rootDir, origin: "global" }],
  });
  return recordInstalledPluginIndexInstallOwner(
    {
      ...expectDefined(index.plugins[0], "fixture plugin"),
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
    },
    pluginId,
  );
}

function installedIndex(
  records: Record<string, PluginInstallRecord>,
  plugin?: InstalledPluginIndexRecord,
): InstalledPluginIndex {
  return {
    ...createPluginMetadataSnapshotFixture().index,
    installRecords: records,
    plugins: plugin ? [plugin] : [],
  };
}

const updateResult = (config: OpenClawConfig, changed = true) => ({
  config,
  changed,
  outcomes: [],
});

describe("plugin release cohort package reconciliation", () => {
  const tempDirs: string[] = [];
  afterEach(() => cleanupTrackedTempDirs(tempDirs));
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.resetAllMocks();
    collectMissingPluginInstallPayloadsMock.mockResolvedValue([]);
    syncPluginsForUpdateChannelMock.mockImplementation(async ({ config }) => ({
      config,
      changed: false,
      summary,
    }));
  });

  it("keeps updates and payload verification active without initial install owners", async () => {
    const sourceDiscovery = vi.spyOn(bundledSources, "resolveSourceCheckoutBundledPluginIds");
    const config = { plugins: { entries: { unrelated: { enabled: false } } } };
    const records = {
      introduced: npmRecord("@example/introduced", "/plugins/introduced"),
    } satisfies Record<string, PluginInstallRecord>;
    const updatedConfig = cohort.cohortConfig(records, config.plugins);
    const remaining = [
      { pluginId: "introduced", installPath: "/plugins/introduced", reason: "missing-package-dir" },
    ];
    // A valid empty index makes the old path fail on unwanted discovery, not a mock error.
    loadInstalledPluginIndexMock.mockReturnValue(installedIndex({}));
    updateNpmInstalledPluginsMock.mockResolvedValue(updateResult(updatedConfig));
    collectMissingPluginInstallPayloadsMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(remaining);

    const result = await converge({ config });

    expect(syncPluginsForUpdateChannelMock).toHaveBeenCalledOnce();
    expect(updateNpmInstalledPluginsMock).toHaveBeenCalledOnce();
    expect(collectMissingPluginInstallPayloadsMock).toHaveBeenCalledTimes(2);
    expect(collectMissingPluginInstallPayloadsMock).toHaveBeenNthCalledWith(2, {
      records,
      config: updatedConfig,
      env: undefined,
    });
    expect(result.config).toEqual(updatedConfig);
    expect(result).toMatchObject({
      changed: true,
      npmChanged: true,
      remainingMissingPayloads: remaining,
    });
    expect(loadInstalledPluginIndexMock).not.toHaveBeenCalled();
    expect(sourceDiscovery).not.toHaveBeenCalled();
  });

  it.each(["global", "ambiguous-config"] as const)(
    "refuses %s package ownership without guessing or changing its install",
    async (kind) => {
      const rootDir = "/plugins/ownerless";
      const records = {
        ownerless: npmRecord("@example/ownerless", rootDir),
      } satisfies Record<string, PluginInstallRecord>;
      const plugin = {
        ...pluginRecord("ownerless", rootDir),
        installOwner: undefined,
        origin: kind === "global" ? ("global" as const) : ("config" as const),
      };
      if (kind === "ambiguous-config") {
        recordInstalledPluginIndexInstallOwner(plugin, undefined, true);
      }
      const config = cohort.cohortConfig(
        records,
        kind === "ambiguous-config" ? { load: { paths: [rootDir] } } : {},
      );
      loadInstalledPluginIndexMock.mockReturnValue(installedIndex(records, plugin));
      const result = converge({ config });

      await expect(result).rejects.toThrow(
        kind === "global"
          ? 'Plugin "ownerless" has no authoritative package-owner metadata. Package maintenance requires an unambiguous install record and its discovered package owner.'
          : 'Plugin "ownerless" has ambiguous package ownership',
      );
      expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
      expect(config.plugins.installs).toEqual(records);
    },
  );

  it.each(["missing", "replaced", "replaced after sync introduces its owner"] as const)(
    "reconciles %s payloads against the new package metadata",
    async (state) => {
      const { loadInstalledPluginIndex } = await vi.importActual<
        typeof import("./installed-plugin-index.js")
      >("./installed-plugin-index.js");
      loadInstalledPluginIndexMock.mockImplementation(loadInstalledPluginIndex);
      const root = fs.realpathSync(makeTrackedTempDir("openclaw-cohort", tempDirs));
      const installPath = path.join(root, "package");
      const env = { ...process.env, ...cohort.createCohortEnv(root) };
      const writePayload = (id: string) =>
        cohort.writeCohortPackage(installPath, id, { packageName: "@example/cohort" });
      if (state !== "missing") {
        writePayload("retired-child");
      }
      const records = {
        cohort: { source: "npm", spec: "@example/cohort", installPath },
      } satisfies Record<string, PluginInstallRecord>;
      const config = cohort.cohortConfig(records, {
        entries: { "retired-child": { enabled: true }, unrelated: { enabled: false } },
      });
      if (state === "missing") {
        collectMissingPluginInstallPayloadsMock.mockResolvedValueOnce([
          { pluginId: "cohort", installPath, reason: "missing-package-dir" },
        ]);
      }
      updateNpmInstalledPluginsMock.mockImplementation(async ({ config: current }) => {
        writePayload("current-child");
        return updateResult({
          ...current,
          ...cohort.cohortConfig(
            { cohort: { ...records.cohort, version: "1.0.0" } },
            current.plugins,
          ),
        });
      });

      if (state === "replaced after sync introduces its owner") {
        syncPluginsForUpdateChannelMock.mockResolvedValueOnce({
          config,
          changed: true,
          summary,
        });
      }
      const inputConfig =
        state === "replaced after sync introduces its owner"
          ? cohort.cohortConfig({}, config.plugins)
          : config;
      const result = await withPluginCache(createPluginCache(), () =>
        converge({ config: inputConfig, env }),
      );

      expect(result.config.plugins?.entries?.unrelated).toEqual({ enabled: false });
      if (state !== "missing") {
        expect(result.config.plugins?.entries).not.toHaveProperty("retired-child");
      }
      expect(result.config.plugins?.installs?.cohort?.version).toBe("1.0.0");
    },
  );

  it.each(["update", "repair"])("reconciles the %s owner migration", async (phase) => {
    const legacyRoot = "/plugins/qqbot-legacy";
    const canonicalRoot = "/plugins/openclaw-qqbot";
    const legacyRecords = {
      unrelated: npmRecord("@example/unrelated", "/plugins/unrelated"),
      qqbot: npmRecord("@openclaw/qqbot@1.9.0", legacyRoot),
      "openclaw-qqbot": npmRecord("@tencent-connect/openclaw-qqbot@2.0.1", canonicalRoot),
    } satisfies Record<string, PluginInstallRecord>;
    const canonicalRecords = {
      unrelated: legacyRecords.unrelated,
      "openclaw-qqbot": npmRecord("@tencent-connect/openclaw-qqbot@2.0.3", canonicalRoot),
    } satisfies Record<string, PluginInstallRecord>;
    const config = {
      channels: { qqbot: { enabled: true, appId: "app", clientSecret: "secret" } },
      plugins: {
        load: { paths: [legacyRoot, `${legacyRoot}/index.js`, "/plugins/unrelated.js"] },
        installs: legacyRecords,
      },
    } satisfies OpenClawConfig;
    const updatedConfig = { ...config, ...cohort.cohortConfig(canonicalRecords, config.plugins) };
    const legacyIndex = installedIndex(legacyRecords, pluginRecord("qqbot", legacyRoot));
    loadInstalledPluginIndexMock
      .mockReturnValueOnce(legacyIndex)
      .mockReturnValueOnce(legacyIndex)
      .mockReturnValueOnce(
        installedIndex(canonicalRecords, pluginRecord("openclaw-qqbot", canonicalRoot)),
      );
    if (phase === "repair") {
      collectMissingPluginInstallPayloadsMock.mockResolvedValueOnce([
        { pluginId: "qqbot", installPath: legacyRoot, reason: "missing-package-json" },
      ]);
    }
    updateNpmInstalledPluginsMock.mockImplementation(async ({ config: current }) =>
      updateResult(current, false),
    );
    updateNpmInstalledPluginsMock.mockResolvedValueOnce(
      attachPluginInstallOwnerMigrations(updateResult(updatedConfig), { qqbot: "openclaw-qqbot" }),
    );

    const result = await converge({ config });

    if (phase === "repair") {
      const ordinaryUpdateRequest = updateNpmInstalledPluginsMock.mock.lastCall?.[0];
      expect(ordinaryUpdateRequest?.config).toEqual(updatedConfig);
      expect(ordinaryUpdateRequest?.skipIds).toEqual(new Set(["qqbot", "openclaw-qqbot"]));
    }
    expect(result.changed).toBe(true);
    expect(result.config.channels?.qqbot).toEqual(config.channels.qqbot);
    expect(result.config.plugins?.installs).toEqual(canonicalRecords);
    expect(result.config.plugins?.load?.paths).toEqual(["/plugins/unrelated.js"]);
  });

  it("rejects a repair owner migration when caller authority is revoked before the cohort resumes", async () => {
    const records = {
      legacy: npmRecord("@example/legacy", "/plugins/legacy"),
    } satisfies Record<string, PluginInstallRecord>;
    const config = cohort.cohortConfig(records);
    const repair = attachPluginInstallOwnerMigrations(
      updateResult(
        cohort.cohortConfig({ canonical: npmRecord("@example/canonical", "/plugins/canonical") }),
      ),
      { legacy: "canonical" },
    );
    const failure = new Error("original update authority revoked");
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw failure;
      }
    };
    loadInstalledPluginIndexMock.mockReturnValue(installedIndex(records));
    collectMissingPluginInstallPayloadsMock.mockResolvedValueOnce([
      { pluginId: "legacy", installPath: "/plugins/legacy", reason: "missing-package-json" },
    ]);
    updateNpmInstalledPluginsMock.mockResolvedValue(repair).mockImplementationOnce(async () => {
      // Revoke after repair returns but before the awaiting cohort continues.
      queueMicrotask(() => {
        current = false;
      });
      return repair;
    });

    const request = { config, beforePersistentEffect: assertCurrent };
    await expect(converge(request)).rejects.toBe(failure);
    expect(updateNpmInstalledPluginsMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ pluginIds: ["legacy"], beforePersistentEffect: assertCurrent }),
    );
    expect(loadInstalledPluginIndexMock).toHaveBeenCalledOnce();
    expect(collectMissingPluginInstallPayloadsMock).toHaveBeenCalledOnce();
  });
});
