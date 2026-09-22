import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyExclusiveSlotSelectionMock,
  configWriteMock,
  applyPluginUninstallDirectoryRemovalMock,
  buildPluginSnapshotReportMock,
  loadPluginManifestRegistryMock,
  planPluginUninstallMock,
  refreshPluginRegistryMock,
  resetPluginsCliTestState,
  pluginsCliRuntimeLogs,
  setInstalledPluginIndexInstallRecords,
} from "../cli/plugins-cli-test-helpers.js";
import type { PluginInstallRuntimeDeferral } from "./install-runtime-batch.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";

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

describe("plugin install persistence warning audiences", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
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
      actions: {},
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

  it("reports missing required configuration without forwarding informational logs", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const warn = vi.fn();
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        recordPluginManifestInstallOwner(
          {
            id: "workboard",
            manifestPath: `${install.installPath}/openclaw.plugin.json`,
            configSchema: {
              type: "object",
              required: ["token"],
              properties: { token: { type: "string" } },
            },
          },
          "workboard",
        ),
      ],
      diagnostics: [],
    });

    const next = await persistPluginInstall({
      snapshot,
      pluginId: "workboard",
      install,
      persistenceLogger: { warn },
    });

    expect(next.plugins?.entries?.workboard).toEqual({ enabled: false });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Installed plugin "workboard" without enabling it because it requires configuration first. Configure it, then run `openclaw plugins enable workboard`.',
    );
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("requires configuration first");
    expect(pluginsCliRuntimeLogs).toContain("Installed plugin: workboard");
  });

  it("preserves owner-authored exclusive-slot warnings verbatim", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const warn = vi.fn();
    const warning = 'Exclusive slot "memory" switched from "memory-core" to "workboard".';
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        recordPluginManifestInstallOwner(
          {
            id: "workboard",
            kind: "memory",
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            origin: "config",
            rootDir: install.installPath,
            source: `${install.installPath}/index.js`,
            manifestPath: `${install.installPath}/openclaw.plugin.json`,
          },
          "workboard",
        ),
      ],
      diagnostics: [],
    });
    applyExclusiveSlotSelectionMock.mockReturnValue({
      config: {},
      warnings: [warning],
      changed: true,
    });

    await persistPluginInstall({
      snapshot,
      pluginId: "workboard",
      install,
      persistenceLogger: { warn },
    });

    expect(warn).toHaveBeenCalledExactlyOnceWith(warning);
  });

  it.each(["management", "terminal"] as const)(
    "keeps sensitive install details appropriate for the %s audience",
    async (audience) => {
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
        actions: {},
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
        ...(audience === "management" ? { persistenceLogger: { warn } } : {}),
      });

      if (audience === "terminal") {
        expect(warn).not.toHaveBeenCalled();
      } else {
        const warnings = warn.mock.calls.map(([message]) => String(message));
        expect(warnings).toHaveLength(3);
        expect(warnings.join("\n")).toContain("previous plugin installation");
        expect(warnings.join("\n")).toContain("registry");
        expect(warnings.join("\n")).toContain("shadowed");
        expect(warnings.join("\n")).not.toContain("/private/");
        expect(warnings.join("\n")).not.toContain("PRIVATE_NPM_MARKER");
        expect(warnings.join("\n")).not.toContain("PRIVATE_REFRESH_MARKER");
      }
      expect(pluginsCliRuntimeLogs.join("\n")).toContain(cleanupDetail);
      expect(pluginsCliRuntimeLogs.join("\n")).toContain(refreshDetail);
      expect(pluginsCliRuntimeLogs.join("\n")).toContain(configuredSource);
      expect(pluginsCliRuntimeLogs.join("\n")).toContain(install.installPath);
    },
  );
});
