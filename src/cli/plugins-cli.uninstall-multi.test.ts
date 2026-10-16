import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { installedPluginRoot } from "../plugin-sdk/test-helpers/bundled-plugin-paths.js";
import { recordInstalledPluginIndexInstallOwner } from "../plugins/installed-plugin-index-install-owner.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  applyPluginUninstallDirectoryRemovalMock,
  buildPluginSnapshotReportMock,
  configWriteMock,
  planPluginUninstallMock,
  pluginCliConfigMock,
  pluginLifecycleGatewayMock,
  pluginsCliRuntimeLogs,
  PromptInputClosedError,
  promptYesNoMock,
  resetPluginsCliTestState,
  resolvePluginLifecycleGatewayMock,
  runPluginsCommand,
  setInstalledPluginIndexInstallRecords,
} from "./plugins-cli-test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let readInstallRecords: (typeof import("../plugins/installed-plugin-index-record-reader.js"))["loadInstalledPluginIndexInstallRecordsSync"];

function uninstall(...args: string[]) {
  return runPluginsCommand(["plugins", "uninstall", ...args]);
}

function expectRuntimeLogIncludes(fragment: string) {
  expect(pluginsCliRuntimeLogs.join("\n")).toContain(fragment);
}

describe("plugins cli multi-package uninstall", () => {
  beforeEach(async () => {
    resetPluginsCliTestState();
    ({ loadInstalledPluginIndexInstallRecordsSync: readInstallRecords } =
      await import("../plugins/installed-plugin-index-record-reader.js"));
    const actual =
      await vi.importActual<typeof import("../plugins/uninstall.js")>("../plugins/uninstall.js");
    planPluginUninstallMock.mockImplementation((params) =>
      actual.planPluginUninstall(params as Parameters<typeof actual.planPluginUninstall>[0]),
    );
    configWriteMock.mockImplementation(async (config) => {
      pluginCliConfigMock.mockReturnValue(config as OpenClawConfig);
    });
  });

  afterEach(() => closeOpenClawStateDatabaseForTest());

  it("deduplicates selected children and aliases by package owner", async () => {
    const packageInstallPath = installedPluginRoot(
      tempDirs.make("openclaw-cli-uninstall-multi-"),
      "pack",
    );
    await fs.mkdir(packageInstallPath, { recursive: true });
    await fs.writeFile(path.join(packageInstallPath, "keep.txt"), "owned plugin files");
    const installRecords = {
      pack: {
        source: "path" as const,
        sourcePath: packageInstallPath,
        installPath: packageInstallPath,
      },
    };
    pluginCliConfigMock.mockReturnValue({
      plugins: { entries: { "pack/one": { enabled: true }, "pack/two": { enabled: true } } },
      channels: { first: { enabled: true }, second: { enabled: true }, unrelated: {} },
    } as OpenClawConfig);
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [
        { id: "pack/one", name: "One", channelIds: ["first"] },
        { id: "pack/two", name: "Two", channelIds: ["second"] },
      ],
      diagnostics: [],
    });
    const installedIndexModule = await import("../plugins/installed-plugin-index.js");
    const { index } = createPluginMetadataSnapshotFixture({
      plugins: ["pack/one", "pack/two"].map((id) => ({
        id,
        rootDir: packageInstallPath,
        origin: "global",
      })),
    });
    index.installRecords = installRecords;
    for (const record of index.plugins) {
      recordInstalledPluginIndexInstallOwner(record, "pack");
    }
    const indexSpy = vi
      .spyOn(installedIndexModule, "loadInstalledPluginIndex")
      .mockReturnValue(index);
    try {
      await uninstall("pack/one", "pack/two", "pack", "One", "pack/one", "--force", "--keep-files");
      expect(pluginsCliRuntimeLogs.filter((line) => line.startsWith("Plugin:"))).toHaveLength(1);
      expectRuntimeLogIncludes("all entries will be removed: pack/one, pack/two");
      expectRuntimeLogIncludes("channels.first");
      expectRuntimeLogIncludes("channels.second");
      expect(promptYesNoMock).not.toHaveBeenCalled();
      expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(packageInstallPath, "keep.txt"), "utf8")).toBe(
        "owned plugin files",
      );
      expect(readInstallRecords()).toEqual({});
      expect(pluginCliConfigMock().plugins?.entries).toEqual({
        "pack/one": { enabled: false },
        "pack/two": { enabled: false },
      });
      expect(pluginCliConfigMock().channels).toEqual({ unrelated: {} });
      expect(configWriteMock).toHaveBeenCalledOnce();
    } finally {
      indexSpy.mockRestore();
    }
  });

  describe("multiple package owners", () => {
    beforeEach(() => {
      const ids = ["alpha", "beta", "gamma"];
      pluginCliConfigMock.mockReturnValue({
        plugins: { entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])) },
      });
      setInstalledPluginIndexInstallRecords(
        Object.fromEntries(ids.map((id) => [id, { source: "npm", spec: `${id}@1.0.0` }])),
      );
      buildPluginSnapshotReportMock.mockReturnValue({
        plugins: ids.map((id) => ({ id, name: id })),
        diagnostics: [],
      });
    });

    it.each([true])("rejects a later invalid target before removal (online=%s)", async (online) => {
      if (online) {
        resolvePluginLifecycleGatewayMock.mockResolvedValue(pluginLifecycleGatewayMock);
      }
      await expect(uninstall("alpha", "missing", "--force", "--keep-files")).rejects.toThrow(
        "is not associated with a tracked package install",
      );
      expect(Object.keys(readInstallRecords())).toEqual(["alpha", "beta", "gamma"]);
      expect(configWriteMock).not.toHaveBeenCalled();
      expect(pluginLifecycleGatewayMock).not.toHaveBeenCalled();
    });

    it("previews every dry-run package without prompting or mutating", async () => {
      await uninstall("beta", "alpha", "--dry-run");
      expect(pluginsCliRuntimeLogs.filter((line) => line.startsWith("Plugin:"))).toEqual([
        "Plugin: beta",
        "Plugin: alpha",
      ]);
      expect(promptYesNoMock).not.toHaveBeenCalled();
      expect(configWriteMock).not.toHaveBeenCalled();
      expect(Object.keys(readInstallRecords())).toEqual(["alpha", "beta", "gamma"]);
    });

    it.each(["declined", "closed"])(
      "stops at a %s confirmation and retains earlier removals",
      async (answer) => {
        promptYesNoMock.mockResolvedValueOnce(true);
        if (answer === "closed") {
          promptYesNoMock.mockRejectedValueOnce(new PromptInputClosedError());
        } else {
          promptYesNoMock.mockResolvedValueOnce(false);
        }
        const command = uninstall("alpha", "beta", "gamma", "--keep-files");
        if (answer === "closed") {
          await expect(command).rejects.toThrow("requires confirmation input");
        } else {
          await command;
          expectRuntimeLogIncludes("Cancelled.");
        }
        expect(promptYesNoMock.mock.calls.map(([question]) => question)).toEqual([
          'Uninstall plugin "alpha"?',
          'Uninstall plugin "beta"?',
        ]);
        expect(Object.keys(readInstallRecords())).toEqual(["beta", "gamma"]);
        expect(pluginCliConfigMock().plugins?.entries).toEqual({
          alpha: { enabled: false },
          beta: { enabled: true },
          gamma: { enabled: true },
        });
      },
    );

    it("routes each package in order to the Gateway and stops when runtime drain fails", async () => {
      resolvePluginLifecycleGatewayMock.mockResolvedValue(pluginLifecycleGatewayMock);
      pluginLifecycleGatewayMock
        .mockResolvedValueOnce({ pluginId: "beta", removed: ["install record"] })
        .mockRejectedValueOnce(new Error("runtime drain failed"));
      await expect(uninstall("beta", "alpha", "gamma", "--force", "--keep-files")).rejects.toThrow(
        "runtime drain failed",
      );
      expect(pluginLifecycleGatewayMock.mock.calls).toEqual([
        ["plugins.uninstall", { pluginId: "beta", keepFiles: true }],
        ["plugins.uninstall", { pluginId: "alpha", keepFiles: true }],
      ]);
      expect(configWriteMock).not.toHaveBeenCalled();
      expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
      expectRuntimeLogIncludes('Uninstalled plugin "beta"');
    });
  });
});
