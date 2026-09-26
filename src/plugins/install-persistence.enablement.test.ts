// Plugin install enablement tests cover child policy, slot selection, and required config.
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyExclusiveSlotSelectionMock,
  buildPluginDiagnosticsReportMock,
  configWriteMock,
  enablePluginInConfigMock,
  loadPluginManifestRegistryMock,
  pluginsCliRuntimeLogs,
  resetPluginsCliTestState,
  setInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
} from "../cli/plugins-cli-test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
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
  return { config, baseHash: "config-1", writeOptions: installWriteOptions };
}

describe("persistPluginInstall enablement", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    resetPluginsCliTestState();
  });

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

  it.each([
    { pluginId: "legacy-memory", kind: undefined },
    { pluginId: "memory-b", kind: "memory" as const },
  ])("selects the $pluginId memory slot with scoped kind discovery", async ({ pluginId, kind }) => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const baseConfig: OpenClawConfig = {
      plugins: { entries: { "legacy-memory-a": { enabled: true } } },
    };
    const enabledConfig: OpenClawConfig = {
      plugins: {
        entries: { "legacy-memory-a": { enabled: true }, [pluginId]: { enabled: true } },
      },
    };
    enablePluginInConfigMock.mockReturnValue({ config: enabledConfig, enabled: true });
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [createManifestRecord(pluginId, kind ? { kind } : {})],
      diagnostics: [],
    });
    if (!kind) {
      buildPluginDiagnosticsReportMock.mockReturnValueOnce({
        plugins: [{ id: pluginId, kind: "memory" }],
        diagnostics: [],
      });
    }
    applyExclusiveSlotSelectionMock.mockImplementation(((params: {
      config: OpenClawConfig;
      selectedId: string;
      selectedKind?: string;
      registry?: { plugins: Array<{ id: string; kind?: string }> };
    }) => {
      expect(params.selectedId).toBe(pluginId);
      expect(params.selectedKind).toBe("memory");
      expect(
        params.registry?.plugins.map((plugin) => ({ id: plugin.id, kind: plugin.kind })),
      ).toEqual([{ id: pluginId, kind: "memory" }]);
      return {
        config: {
          ...params.config,
          plugins: {
            ...params.config.plugins,
            slots: { ...params.config.plugins?.slots, memory: pluginId },
          },
        },
        warnings: [],
        changed: true,
      };
    }) as (...args: unknown[]) => unknown);

    const next = await persistPluginInstall({
      snapshot: installSnapshot(baseConfig),
      pluginId,
      install: {
        source: "path",
        sourcePath: `/tmp/${pluginId}`,
        installPath: `/tmp/${pluginId}`,
      },
    });

    if (kind) {
      expect(buildPluginDiagnosticsReportMock).not.toHaveBeenCalled();
    } else {
      expect(buildPluginDiagnosticsReportMock).toHaveBeenCalledTimes(1);
      expect(buildPluginDiagnosticsReportMock).toHaveBeenCalledWith(
        expect.objectContaining({ config: enabledConfig, onlyPluginIds: [pluginId] }),
      );
    }
    expect(
      requireMockCallArg(loadPluginManifestRegistryMock, "loadPluginManifestRegistryMock", 1)
        .config,
    ).toBe(enabledConfig);
    expect(next.plugins?.entries?.["legacy-memory-a"]?.enabled).toBe(true);
    expect(next.plugins?.slots?.memory).toBe(pluginId);
  });

  it("does not load every plugin runtime for non-slot installs without manifest kind", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const baseConfig = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledConfig = {
      plugins: {
        entries: {
          plain: { enabled: true },
        },
      },
    } as OpenClawConfig;
    enablePluginInConfigMock.mockReturnValue({ config: enabledConfig, enabled: true });
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [createManifestRecord("plain")],
      diagnostics: [],
    });
    buildPluginDiagnosticsReportMock.mockReturnValue({
      plugins: [{ id: "plain" }],
      diagnostics: [],
    });
    applyExclusiveSlotSelectionMock.mockReturnValue({
      config: enabledConfig,
      warnings: [],
      changed: false,
    });

    const next = await persistPluginInstall({
      snapshot: installSnapshot(baseConfig),
      pluginId: "plain",
      install: {
        source: "path",
        sourcePath: "/tmp/plain",
        installPath: "/tmp/plain",
      },
    });

    expect(buildPluginDiagnosticsReportMock).toHaveBeenCalledTimes(1);
    expect(buildPluginDiagnosticsReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: enabledConfig,
        onlyPluginIds: ["plain"],
      }),
    );
    expect(
      requireMockCallArg(loadPluginManifestRegistryMock, "loadPluginManifestRegistryMock", 1)
        .config,
    ).toBe(enabledConfig);
    expect(next).toEqual(enabledConfig);
  });

  it("installs a plugin disabled when its required configuration is missing", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
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

  it("can persist an install record without enabling a plugin that needs config first", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const baseConfig = {
      plugins: {
        entries: {},
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

    expect(next).toEqual(baseConfig);
    expect(enablePluginInConfigMock).not.toHaveBeenCalled();
    expect(applyExclusiveSlotSelectionMock).not.toHaveBeenCalled();
    const persistedRecords = requireMockCallArg(
      writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
      "writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock",
    );
    expect(persistedRecords["memory-lancedb"]).toEqual({
      source: "path",
      spec: "memory-lancedb",
      sourcePath: "/app/dist/extensions/memory-lancedb",
      installPath: "/app/dist/extensions/memory-lancedb",
      installedAt: "2026-04-25T00:00:00.000Z",
    });
    expect(configWriteMock).toHaveBeenCalledWith(baseConfig);
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
