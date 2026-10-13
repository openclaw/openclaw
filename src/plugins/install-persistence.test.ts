// Plugin install persistence tests cover saving installed plugin records after install.
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
import type { PluginInstallRuntimeDeferral } from "./install-runtime-batch.js";
import { hasRetainedManagedNpmInstallMarker } from "./managed-npm-retention.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

function requireMockCallArg(
  mockFn: { mock: { calls: unknown[][] } },
  label: string,
  index = 0,
): Record<string, unknown> {
  const arg = mockFn.mock.calls[index]?.[0] as Record<string, unknown> | undefined;
  if (!arg) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return arg;
}

function mockEnabledPlugin(pluginId: string): OpenClawConfig {
  const config = { plugins: { entries: { [pluginId]: { enabled: true } } } };
  enablePluginInConfigMock.mockReturnValue({ config, enabled: true });
  return config;
}

function expectRuntimeLogIncludes(fragment: string) {
  expect(pluginsCliRuntimeLogs.join("\n")).toContain(fragment);
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
    const { persistPluginInstall } = await import("./install-persistence.js");
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
    expect(replaceConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        writeOptions: expect.objectContaining({
          afterWrite: expect.objectContaining({ mode: "none" }),
        }),
      }),
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it.each(["before index", "at config publication"])(
    "rejects an expired owner %s and restores tentative state",
    async (phase) => {
      const { persistPluginInstall } = await import("./install-persistence.js");
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

    expect(
      selectInstallMutationWriteOptions({
        expectedConfigPath: "/tmp/openclaw.json",
        ownedConfigPathForWrite: "/tmp/openclaw.json",
      }),
    ).toMatchObject({
      auditOrigin: "plugin-install",
      expectedConfigPath: "/tmp/openclaw.json",
      ownedConfigPathForWrite: "/tmp/openclaw.json",
    });
  });

  it("persists installs even when runtime cache invalidation fails", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const baseConfig: OpenClawConfig = { plugins: { entries: {} } };
    const enabledConfig = mockEnabledPlugin("alpha");
    clearPluginRegistryLoadCacheMock.mockImplementation(() => {
      throw new Error("cache unavailable");
    });

    const next = await persistPluginInstall({
      snapshot: installSnapshot(baseConfig),
      pluginId: "alpha",
      install: {
        source: "npm",
        spec: "alpha@1.0.0",
        installPath: "/tmp/alpha",
      },
    });

    expect(next).toEqual(enabledConfig);
    expect(refreshPluginRegistryMock).toHaveBeenCalledTimes(1);
    expectRuntimeLogIncludes("Plugin runtime cache invalidation failed");
  });

  it("removes a replaced managed install directory before refreshing the registry", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const baseConfig: OpenClawConfig = { plugins: { entries: {} } };
    mockEnabledPlugin("codex");
    setInstalledPluginIndexInstallRecords({
      codex: {
        source: "clawhub",
        spec: "clawhub:@openclaw/codex",
        installPath: "/tmp/openclaw/extensions/codex",
      },
    });
    planPluginUninstallMock.mockReturnValueOnce({
      ok: true,
      config: {} as OpenClawConfig,
      pluginId: "codex",
      actions: { ...createEmptyUninstallActions(), install: true },
      directoryRemoval: {
        target: "/tmp/openclaw/extensions/codex",
      },
    });
    applyPluginUninstallDirectoryRemovalMock.mockResolvedValueOnce({
      directoryRemoved: true,
      warnings: [],
    });

    await persistPluginInstall({
      snapshot: installSnapshot(baseConfig),
      pluginId: "codex",
      install: {
        source: "npm",
        spec: "@openclaw/codex",
        installPath: "/tmp/openclaw/npm/node_modules/@openclaw/codex",
      },
    });

    expect(planPluginUninstallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          plugins: {
            installs: {
              codex: {
                source: "clawhub",
                spec: "clawhub:@openclaw/codex",
                installPath: "/tmp/openclaw/extensions/codex",
              },
            },
          },
        },
        pluginId: "codex",
        deleteFiles: true,
      }),
    );
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
    const { persistPluginInstall } = await import("./install-persistence.js");
    const baseConfig: OpenClawConfig = { plugins: { entries: {} } };
    mockEnabledPlugin("codex");
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-persist-"));
    const previousProjectRoot = path.join(tempRoot, "npm", "projects", "codex-v1");
    const previousInstallPath = path.join(
      previousProjectRoot,
      "node_modules",
      "@openclaw",
      "codex",
    );
    const nextInstallPath = path.join(
      tempRoot,
      "npm",
      "projects",
      "codex-v2",
      "node_modules",
      "@openclaw",
      "codex",
    );
    fs.mkdirSync(previousInstallPath, { recursive: true });
    setInstalledPluginIndexInstallRecords({
      codex: {
        source: "npm",
        spec: "@openclaw/codex@1.0.0",
        installPath: previousInstallPath,
      },
    });
    planPluginUninstallMock.mockReturnValueOnce({
      ok: true,
      config: {} as OpenClawConfig,
      pluginId: "codex",
      actions: { ...createEmptyUninstallActions(), install: true },
      directoryRemoval: {
        target: previousInstallPath,
        cleanup: {
          kind: "npm",
          npmRoot: previousProjectRoot,
          packageName: "@openclaw/codex",
          rootKind: "isolated-project",
        },
      },
    });

    try {
      await persistPluginInstall({
        snapshot: installSnapshot(baseConfig),
        pluginId: "codex",
        install: {
          source: "npm",
          spec: "@openclaw/codex@2.0.0",
          installPath: nextInstallPath,
        },
      });

      expect(planPluginUninstallMock).toHaveBeenCalledWith(
        expect.objectContaining({
          config: {
            plugins: {
              installs: {
                codex: {
                  source: "npm",
                  spec: "@openclaw/codex@1.0.0",
                  installPath: previousInstallPath,
                },
              },
            },
          },
          pluginId: "codex",
          deleteFiles: true,
        }),
      );
      expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
      expect(hasRetainedManagedNpmInstallMarker(previousInstallPath)).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not warn when the config-selected source is inside the npm install path", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const baseConfig: OpenClawConfig = { plugins: { entries: {} } };
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

    await persistPluginInstall({
      snapshot: installSnapshot(baseConfig),
      pluginId: "discord",
      install: {
        source: "npm",
        spec: "@openclaw/discord",
        installPath: "/tmp/openclaw/npm/node_modules/@openclaw/discord",
      },
    });

    expect(pluginsCliRuntimeLogs.join("\n")).not.toContain("is not the active source");
  });
});

describe("persistPluginInstall enablement", () => {
  it("restores runtime child policy when reinstalling its package owner", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const baseConfig = {
      plugins: {
        allow: ["memory-core"],
        deny: ["demo-plugin-npm", "other"],
      },
    } as OpenClawConfig;
    setInstalledPluginIndexInstallRecords({
      "demo-package": { source: "npm", spec: "@openclaw/demo-package@0.0.1" },
    });
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [createManifestRecord("demo-plugin-npm", {}, "demo-package")],
      diagnostics: [],
    });

    const next = await persistPluginInstall({
      snapshot: installSnapshot(baseConfig),
      pluginId: "demo-package",
      install: {
        source: "npm",
        spec: "@openclaw/demo-package@0.0.1",
        installPath: "/tmp/demo-package",
      },
    });

    expect(next.plugins?.allow).toEqual(["memory-core", "demo-plugin-npm"]);
    expect(next.plugins?.deny).toEqual(["other"]);
    expect(enablePluginInConfigMock).toHaveBeenCalledTimes(1);
  });

  it("installs a plugin disabled when its required configuration is missing", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
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
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        createManifestRecord("needs-config", {
          configSchema: {
            type: "object",
            required: ["token"],
            properties: { token: { type: "string" } },
          },
        }),
      ],
      diagnostics: [],
    });

    const next = await persistPluginInstall({
      snapshot: installSnapshot(baseConfig),
      pluginId: "needs-config",
      persistenceLogger: { warn },
      install: {
        source: "npm",
        spec: "needs-config@1.0.0",
        installPath: "/tmp/needs-config",
      },
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
    const persistedRecords = requireMockCallArg(
      writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
      "writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock",
    );
    expect(persistedRecords["needs-config"]).toMatchObject({
      source: "npm",
      spec: "needs-config@1.0.0",
      installPath: "/tmp/needs-config",
    });
  });

  it("rejects a malformed manifest schema instead of treating it as missing config", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const baseConfig = {
      plugins: { allow: ["memory-core"], deny: ["broken-schema"], entries: {} },
    } as OpenClawConfig;
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        createManifestRecord("broken-schema", {
          configSchema: {
            type: "object",
            properties: { mode: { $ref: "#/$defs/Mode" } },
          },
        }),
      ],
      diagnostics: [],
    });

    await expect(
      persistPluginInstall({
        snapshot: installSnapshot(baseConfig),
        pluginId: "broken-schema",
        install: {
          source: "npm",
          spec: "broken-schema@1.0.0",
          installPath: "/tmp/broken-schema",
        },
      }),
    ).rejects.toThrow("has invalid configured settings");

    expect(enablePluginInConfigMock).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("rejects invalid authored plugin config even for a disabled install", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const baseConfig = {
      plugins: {
        entries: {
          "needs-config": {
            enabled: false,
            config: null as never,
            hooks: { timeoutMs: 5_000 },
          },
        },
      },
    } as OpenClawConfig;
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        createManifestRecord("needs-config", {
          configSchema: {
            type: "object",
            required: ["token"],
            properties: { token: { type: "string" } },
          },
        }),
      ],
      diagnostics: [],
    });

    await expect(
      persistPluginInstall({
        snapshot: installSnapshot(baseConfig),
        pluginId: "needs-config",
        enable: false,
        install: {
          source: "npm",
          spec: "needs-config@1.0.0",
          installPath: "/tmp/needs-config",
        },
      }),
    ).rejects.toThrow("has invalid configured settings");

    expect(enablePluginInConfigMock).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("does not add disabled installs to restrictive allowlists", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const baseConfig = {
      plugins: {
        allow: ["memory-core"],
        deny: ["memory-lancedb"],
      },
    } as OpenClawConfig;

    const next = await persistPluginInstall({
      snapshot: installSnapshot(baseConfig),
      pluginId: "memory-lancedb",
      enable: false,
      install: {
        source: "path",
        spec: "memory-lancedb",
        sourcePath: "/app/dist/extensions/memory-lancedb",
        installPath: "/app/dist/extensions/memory-lancedb",
      },
    });

    expect(next.plugins?.allow).toEqual(["memory-core"]);
    expect(next.plugins?.deny).toEqual(["memory-lancedb"]);
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
    const { persistPluginInstall } = await import("./install-persistence.js");
    const cleanups: Parameters<PluginInstallRuntimeDeferral["deferCleanup"]>[0][] = [];
    const lateWarning = vi.fn();
    const warning = "Previous plugin source could not be removed";
    setInstalledPluginIndexInstallRecords({
      workboard: { source: "clawhub", installPath: "/private/previous-source/workboard" },
    });
    planPluginUninstallMock.mockReturnValueOnce({
      ok: true,
      config: {},
      pluginId: "workboard",
      actions: createEmptyUninstallActions(),
      directoryRemoval: { target: "/private/previous-source/workboard" },
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
    const { persistPluginInstall } = await import("./install-persistence.js");
    const warn = vi.fn();
    const cleanupDetail = "npm stderr PRIVATE_NPM_MARKER /private/previous-source/workboard";
    const refreshDetail = "PRIVATE_REFRESH_MARKER /private/registry-source/workboard";
    const configuredSource = "/private/configured-source/workboard/index.js";
    setInstalledPluginIndexInstallRecords({
      workboard: {
        source: "clawhub",
        spec: "clawhub:community/workboard",
        installPath: "/private/previous-source/workboard",
      },
    });
    planPluginUninstallMock.mockReturnValueOnce({
      ok: true,
      config: {},
      pluginId: "workboard",
      actions: createEmptyUninstallActions(),
      directoryRemoval: { target: "/private/previous-source/workboard" },
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
    expect(warnings.join("\n")).toContain("previous plugin installation");
    expect(warnings.join("\n")).toContain("registry");
    expect(warnings.join("\n")).toContain("shadowed");
    expect(warnings.join("\n")).not.toContain("/private/");
    expect(warnings.join("\n")).not.toContain("PRIVATE_NPM_MARKER");
    expect(warnings.join("\n")).not.toContain("PRIVATE_REFRESH_MARKER");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain(cleanupDetail);
    expect(pluginsCliRuntimeLogs.join("\n")).toContain(refreshDetail);
    expect(pluginsCliRuntimeLogs.join("\n")).toContain(configuredSource);
    expect(pluginsCliRuntimeLogs.join("\n")).toContain(install.installPath);
  });
});
