import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyExclusiveSlotSelectionMock,
  buildPluginSnapshotReportMock,
  createEmptyUninstallActions,
  loadPluginManifestRegistryMock,
  clearPluginRegistryLoadCacheMock,
  enablePluginInConfigMock,
  planPluginUninstallMock,
  replaceConfigFileMock,
  restorePersistedInstalledPluginIndexIfCurrentMock,
  refreshPluginRegistryMock,
  resetPluginsCliTestState,
  pluginsCliRuntimeLogs,
  setInstalledPluginIndexInstallRecords,
  configWriteMock,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
  applyPluginUninstallDirectoryRemovalMock,
  readConfigFileSnapshotForWriteMock,
} from "../cli/plugins-cli-test-helpers.js";
import { createTestConfigSnapshot } from "../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { PluginInstallRuntimeDeferral } from "./install-runtime-batch.js";
import { hasRetainedManagedNpmInstallMarker } from "./managed-npm-retention.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import type { PluginUninstallDirectoryRemoval } from "./uninstall.js";

async function persistPluginInstall(
  ...args: Parameters<typeof import("./install-persistence.js").persistPluginInstall>
) {
  const owner = await import("./install-persistence.js");
  return owner.persistPluginInstall(...args);
}

type PersistOptions = Parameters<typeof import("./install-persistence.js").persistPluginInstall>[0];
function persistNpm(
  pluginId: string,
  config: OpenClawConfig = { plugins: { entries: {} } },
  options: Partial<PersistOptions> = {},
) {
  return persistPluginInstall({
    pluginId,
    snapshot: installSnapshot(config),
    install: npmInstall(`${pluginId}@1.0.0`),
    ...options,
  });
}

function npmInstall(spec: string, installPath = `/tmp/${spec.split("@")[0]}`) {
  return { source: "npm" as const, spec, installPath };
}

const requiredTokenSchema = {
  type: "object",
  required: ["token"],
  properties: { token: { type: "string" } },
};

function mockReplacedInstall(
  pluginId: string,
  previous: PluginInstallRecord & { installPath: string },
  install = false,
  cleanup?: PluginUninstallDirectoryRemoval["cleanup"],
) {
  setInstalledPluginIndexInstallRecords({ [pluginId]: previous });
  planPluginUninstallMock.mockReturnValueOnce({
    ok: true,
    config: {},
    pluginId,
    actions: { ...createEmptyUninstallActions(), ...(install ? { install: true } : {}) },
    directoryRemoval: { target: previous.installPath, ...(cleanup ? { cleanup } : {}) },
  });
}
function expectUninstallPlan(pluginId: string, previous: PluginInstallRecord) {
  expect(planPluginUninstallMock).toHaveBeenCalledWith(
    expect.objectContaining({
      config: { plugins: { installs: { [pluginId]: previous } } },
      pluginId,
      deleteFiles: true,
    }),
  );
}

function mockEnabledPlugin(pluginId: string): OpenClawConfig {
  const config = { plugins: { entries: { [pluginId]: { enabled: true } } } };
  enablePluginInConfigMock.mockReturnValue({ config, enabled: true });
  return config;
}

function expectRuntimeLogIncludes(fragment: string) {
  expect(pluginsCliRuntimeLogs.join("\n")).toContain(fragment);
}

function setManifests(...plugins: PluginManifestRecord[]) {
  loadPluginManifestRegistryMock.mockReturnValue({ plugins, diagnostics: [] });
}

function createManifestRecord(
  id: string,
  overrides: Partial<PluginManifestRecord> = {},
  owner = id,
): PluginManifestRecord {
  const rootDir = path.join(os.tmpdir(), "openclaw-plugin-fixtures", id);
  return recordPluginManifestInstallOwner(
    {
      id,
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      origin: "config",
      rootDir,
      source: path.join(rootDir, "index.ts"),
      manifestPath: path.join(rootDir, "openclaw.plugin.json"),
      ...overrides,
    },
    owner,
  );
}

const installWriteOptions = {
  assertConfigPathForWrite: () => {},
  expectedConfigPath: "/tmp/openclaw.json",
  ownedConfigPathForWrite: "/tmp/openclaw.json",
};

function installSnapshot(config: OpenClawConfig) {
  readConfigFileSnapshotForWriteMock.mockResolvedValue({
    snapshot: { ...createTestConfigSnapshot(config), hash: "config-1" },
    writeOptions: installWriteOptions,
  });
  return { config, baseHash: "config-1", writeOptions: installWriteOptions };
}

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginsCliTestState();
});

describe("persistPluginInstall", () => {
  it("hands durable batch facts to the coordinator before later output failure", async () => {
    const record = vi.fn();
    const deferRuntime = { record, deferCleanup: vi.fn() };
    const commit = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => undefined);
    const failure = new Error("terminal output unavailable");
    const options = {
      snapshot: { config: {}, baseHash: "config-1", writeOptions: installWriteOptions },
      pluginId: "alpha",
      install: { source: "archive" as const, installPath: "/tmp/alpha" },
      enable: false,
      deferRuntime,
      transaction: { commit, rollback },
      runtime: {
        log: () => {
          throw failure;
        },
      },
    };
    const pending = persistPluginInstall(options);
    await expect(pending).rejects.toMatchObject({ pluginId: "alpha", cause: failure });
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      pluginId: "alpha",
      operation: "install",
      sourceDigests: {},
    });
    expect(replaceConfigFileMock.mock.calls[0]?.[0]).toMatchObject({
      writeOptions: { afterWrite: { mode: "none" } },
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it.each(["before index", "at config publication"])(
    "rejects an expired owner %s and restores tentative state",
    async (phase) => {
      const expired = new Error("approved operation owner expired");
      let ownerActive = phase === "at config publication";
      const replaceConfig = replaceConfigFileMock.getMockImplementation();
      if (!replaceConfig) {
        throw new Error("missing config writer fixture");
      }
      replaceConfigFileMock.mockImplementationOnce(async (params) => {
        await Promise.resolve();
        ownerActive = false;
        await params.writeOptions?.beforeCommit?.();
        return await replaceConfig(params);
      });
      await expect(
        persistPluginInstall({
          snapshot: { config: {}, baseHash: "config-1", writeOptions: installWriteOptions },
          pluginId: "alpha",
          install: { source: "archive", sourcePath: "/tmp/alpha.tgz", installPath: "/tmp/alpha" },
          beforePersistentEffect: async () => {
            if (!ownerActive) {
              throw expired;
            }
          },
        }),
      ).rejects.toBe(expired);
      expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).toHaveBeenCalledTimes(
        phase === "before index" ? 0 : 1,
      );
      expect(restorePersistedInstalledPluginIndexIfCurrentMock).toHaveBeenCalledTimes(
        phase === "before index" ? 0 : 1,
      );
      expect(configWriteMock).not.toHaveBeenCalled();
      expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
    },
  );

  it("labels plugin lifecycle config writes", async () => {
    const { selectInstallMutationWriteOptions } = await import("./install-config-mutation.js");

    const paths = {
      expectedConfigPath: "/tmp/openclaw.json",
      ownedConfigPathForWrite: "/tmp/openclaw.json",
    };
    expect(selectInstallMutationWriteOptions(paths)).toMatchObject({
      ...paths,
      auditOrigin: "plugin-install",
    });
  });

  it("persists installs even when runtime cache invalidation fails", async () => {
    const enabledConfig = mockEnabledPlugin("alpha");
    clearPluginRegistryLoadCacheMock.mockImplementation(() => {
      throw new Error("cache unavailable");
    });

    const next = await persistNpm("alpha");

    expect(next).toEqual(enabledConfig);
    expect(refreshPluginRegistryMock).toHaveBeenCalledTimes(1);
    expectRuntimeLogIncludes("Plugin runtime cache invalidation failed");
  });

  it("removes a replaced managed install directory before refreshing the registry", async () => {
    mockEnabledPlugin("codex");
    const previousInstall = {
      source: "clawhub" as const,
      spec: "clawhub:@openclaw/codex",
      installPath: "/tmp/openclaw/extensions/codex",
    };
    mockReplacedInstall("codex", previousInstall, true);
    applyPluginUninstallDirectoryRemovalMock.mockResolvedValueOnce({
      directoryRemoved: true,
      warnings: [],
    });

    await persistNpm("codex", undefined, {
      install: npmInstall("@openclaw/codex", "/tmp/openclaw/npm/node_modules/@openclaw/codex"),
    });

    expectUninstallPlan("codex", previousInstall);
    expect(applyPluginUninstallDirectoryRemovalMock.mock.calls.map(([removal]) => removal)).toEqual(
      [{ target: "/tmp/openclaw/extensions/codex" }],
    );
    expect(applyPluginUninstallDirectoryRemovalMock).toHaveBeenCalledBefore(
      refreshPluginRegistryMock,
    );
    expect(pluginsCliRuntimeLogs.join("\n")).toContain(
      "Removed previous plugin install directory: /tmp/openclaw/extensions/codex",
    );
  });

  it("preserves replaced npm install directories across generation updates", async () => {
    mockEnabledPlugin("codex");
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-persist-"));
    const previousProjectRoot = path.join(tempRoot, "npm", "projects", "codex-v1");
    const previousInstallPath = path.join(previousProjectRoot, "node_modules/@openclaw/codex");
    const nextInstallPath = path.join(
      tempRoot,
      "npm/projects/codex-v2/node_modules/@openclaw/codex",
    );
    fs.mkdirSync(previousInstallPath, { recursive: true });
    const previousInstall = npmInstall("@openclaw/codex@1.0.0", previousInstallPath);
    mockReplacedInstall("codex", previousInstall, true, {
      kind: "npm",
      npmRoot: previousProjectRoot,
      packageName: "@openclaw/codex",
      rootKind: "isolated-project",
    });

    try {
      await persistNpm("codex", undefined, {
        install: npmInstall("@openclaw/codex@2.0.0", nextInstallPath),
      });

      expectUninstallPlan("codex", previousInstall);
      expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
      expect(hasRetainedManagedNpmInstallMarker(previousInstallPath)).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not warn when the config-selected source is inside the npm install path", async () => {
    mockEnabledPlugin("discord");
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "config",
          source: "/tmp/openclaw/npm/node_modules/@openclaw/discord/dist/index.js",
          status: "loaded",
        },
      ],
      diagnostics: [],
    });

    await persistNpm("discord", undefined, {
      install: npmInstall("@openclaw/discord", "/tmp/openclaw/npm/node_modules/@openclaw/discord"),
    });

    expect(pluginsCliRuntimeLogs.join("\n")).not.toContain("is not the active source");
  });
});

describe("persistPluginInstall enablement", () => {
  it("restores runtime child policy when reinstalling its package owner", async () => {
    const baseConfig = {
      plugins: { allow: ["memory-core"], deny: ["demo-plugin-npm", "other"] },
    } as OpenClawConfig;
    setInstalledPluginIndexInstallRecords({
      "demo-package": { source: "npm", spec: "@openclaw/demo-package@0.0.1" },
    });
    setManifests(createManifestRecord("demo-plugin-npm", {}, "demo-package"));

    const next = await persistNpm("demo-package", baseConfig, {
      install: npmInstall("@openclaw/demo-package@0.0.1", "/tmp/demo-package"),
    });

    expect(next.plugins).toMatchObject({
      allow: ["memory-core", "demo-plugin-npm"],
      deny: ["other"],
    });
    expect(enablePluginInConfigMock).toHaveBeenCalledTimes(1);
  });

  it("installs a plugin disabled when its required configuration is missing", async () => {
    const warn = vi.fn();
    const baseConfig = {
      plugins: {
        allow: ["memory-core"],
        deny: ["needs-config"],
        entries: {
          "needs-config": { hooks: { timeoutMs: 5_000 } },
        },
      },
    } as OpenClawConfig;
    setManifests(createManifestRecord("needs-config", { configSchema: requiredTokenSchema }));

    const next = await persistNpm("needs-config", baseConfig, {
      persistenceLogger: { warn },
    });

    expect(next).toEqual({
      plugins: {
        allow: ["memory-core", "needs-config"],
        entries: {
          "needs-config": { enabled: false, hooks: { timeoutMs: 5_000 } },
        },
      },
    });
    expect(enablePluginInConfigMock).not.toHaveBeenCalled();
    expect(applyExclusiveSlotSelectionMock).not.toHaveBeenCalled();
    expectRuntimeLogIncludes(
      'Installed plugin "needs-config" without enabling it because it requires configuration first.',
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Installed plugin "needs-config" without enabling it because it requires configuration first. Configure it, then run `openclaw plugins enable needs-config`.',
    );
    expect(pluginsCliRuntimeLogs).toContain("Installed plugin: needs-config");
    expect(
      writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock.mock.calls[0]?.[0],
    ).toMatchObject({ "needs-config": npmInstall("needs-config@1.0.0") });
  });

  it.each(["schema", "disabled config"] as const)("rejects invalid %s", async (kind) => {
    const malformedSchema = kind === "schema";
    const pluginId = malformedSchema ? "broken-schema" : "needs-config";
    const config: OpenClawConfig = malformedSchema
      ? {}
      : {
          plugins: { entries: { [pluginId]: { enabled: false, config: null as never } } },
        };
    const configSchema = malformedSchema
      ? { type: "object", properties: { mode: { $ref: "#/$defs/Mode" } } }
      : requiredTokenSchema;
    const enable = malformedSchema ? undefined : false;
    setManifests(createManifestRecord(pluginId, { configSchema }));
    await expect(persistNpm(pluginId, config, { enable })).rejects.toThrow(
      "has invalid configured settings",
    );
    expect(enablePluginInConfigMock).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("does not add disabled installs to restrictive allowlists", async () => {
    const baseConfig = {
      plugins: { allow: ["memory-core"], deny: ["memory-lancedb"] },
    } as OpenClawConfig;

    const next = await persistNpm("memory-lancedb", baseConfig, {
      enable: false,
      install: {
        source: "path",
        spec: "memory-lancedb",
        sourcePath: "/app/dist/extensions/memory-lancedb",
        installPath: "/app/dist/extensions/memory-lancedb",
      },
    });

    expect(next.plugins).toMatchObject({ allow: ["memory-core"], deny: ["memory-lancedb"] });
    expect(next.plugins?.entries?.["memory-lancedb"]).toBeUndefined();
  });
});

describe("plugin install persistence warning audiences", () => {
  const snapshot = {
    config: {},
    baseHash: "config-1",
    writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
  };

  const install = {
    source: "npm" as const,
    spec: "workboard@1.0.0",
    installPath: "/private/managed-source/workboard",
  };

  beforeEach(() => {
    readConfigFileSnapshotForWriteMock.mockResolvedValue({
      snapshot: { ...createTestConfigSnapshot(snapshot.config), hash: snapshot.baseHash },
      writeOptions: snapshot.writeOptions,
    });
  });

  it("delivers deferred source cleanup warnings to the live batch consumer", async () => {
    const cleanups: Parameters<PluginInstallRuntimeDeferral["deferCleanup"]>[0][] = [];
    const lateWarning = vi.fn();
    const warning = "Previous plugin source could not be removed";
    mockReplacedInstall("workboard", {
      source: "clawhub",
      installPath: "/private/previous-source/workboard",
    });
    applyPluginUninstallDirectoryRemovalMock.mockResolvedValueOnce({
      directoryRemoved: false,
      warnings: [warning],
    });
    await persistPluginInstall({
      snapshot,
      pluginId: "workboard",
      install,
      enable: false,
      runtime: { log: () => {} },
      persistenceLogger: { warn: () => {} },
      deferRuntime: { record: () => {}, deferCleanup: (cleanup) => cleanups.push(cleanup) },
    });
    expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
    expect(cleanups).toHaveLength(1);
    await cleanups[0]!(() => {}, lateWarning);
    expect(lateWarning).toHaveBeenCalledExactlyOnceWith(warning);
  });

  it("keeps sensitive install details appropriate for the management audience", async () => {
    const warn = vi.fn();
    const cleanupDetail = "npm stderr PRIVATE_NPM_MARKER /private/previous-source/workboard";
    const refreshDetail = "PRIVATE_REFRESH_MARKER /private/registry-source/workboard";
    const configuredSource = "/private/configured-source/workboard/index.js";
    mockReplacedInstall("workboard", {
      source: "clawhub",
      spec: "clawhub:community/workboard",
      installPath: "/private/previous-source/workboard",
    });
    applyPluginUninstallDirectoryRemovalMock.mockResolvedValueOnce({
      directoryRemoved: false,
      warnings: [cleanupDetail],
    });
    refreshPluginRegistryMock.mockImplementationOnce(async () => {
      expect(configWriteMock).toHaveBeenCalledOnce();
      throw new Error(refreshDetail);
    });
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "workboard", origin: "config", source: configuredSource }],
      diagnostics: [],
    });

    await persistPluginInstall({
      snapshot,
      pluginId: "workboard",
      install,
      persistenceLogger: { warn },
    });

    const warnings = warn.mock.calls.map(([message]) => String(message));
    expect(warnings).toHaveLength(3);
    const warningText = warnings.join("\n");
    const runtimeText = pluginsCliRuntimeLogs.join("\n");
    expect(warningText).toContain("previous plugin installation");
    expect(warningText).toContain("registry");
    expect(warningText).toContain("shadowed");
    expect(warningText).not.toContain("/private/");
    expect(warningText).not.toContain("PRIVATE_NPM_MARKER");
    expect(warningText).not.toContain("PRIVATE_REFRESH_MARKER");
    expect(runtimeText).toContain(cleanupDetail);
    expect(runtimeText).toContain(refreshDetail);
    expect(runtimeText).toContain(configuredSource);
    expect(runtimeText).toContain(install.installPath);
  });
});
