import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { persistClawPackageRef } from "../claws/provenance.js";
import type { ClawAddPlan } from "../claws/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { installedPluginRoot } from "../plugin-sdk/test-helpers/bundled-plugin-paths.js";
import { recordInstalledPluginIndexInstallOwner } from "../plugins/installed-plugin-index-install-owner.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  applyPluginUninstallDirectoryRemovalMock,
  buildPluginDiagnosticsReportMock,
  buildPluginSnapshotReportMock,
  createTestInstalledPluginIndex,
  pluginCliConfigMock,
  pluginLifecycleGatewayMock,
  resolvePluginLifecycleGatewayMock,
  planPluginUninstallMock,
  PromptInputClosedError,
  promptYesNoMock,
  readPersistedInstalledPluginIndexMock,
  refreshPluginRegistryMock,
  replaceConfigFileMock,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  pluginsCliRuntimeLogs,
  setInstalledPluginIndexInstallRecords,
  setPersistedPluginConfig,
  configWriteMock,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
} from "./plugins-cli-test-helpers.js";

let alphaInstallPath: string;
let readInstallRecords: (typeof import("../plugins/installed-plugin-index-record-reader.js"))["loadInstalledPluginIndexInstallRecordsSync"];
const ORIGINAL_OPENCLAW_NIX_MODE = process.env.OPENCLAW_NIX_MODE;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function expectRuntimeLogIncludes(fragment: string) {
  expect(pluginsCliRuntimeLogs.join("\n")).toContain(fragment);
}

function expectInstallRecordsWrittenWithLease(records: unknown, config: unknown) {
  expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).toHaveBeenCalledWith(
    records,
    expect.objectContaining({
      config,
      filePath: expect.any(String),
      lease: expect.anything(),
    }),
  );
}

function configureAlphaInstall(source: "path" | "npm" = "path") {
  const installRecords = {
    alpha:
      source === "path"
        ? { source, sourcePath: alphaInstallPath, installPath: alphaInstallPath }
        : { source, spec: "alpha@1.0.0", installPath: alphaInstallPath },
  };
  const baseConfig: OpenClawConfig = {
    plugins: { entries: { alpha: { enabled: true } }, installs: installRecords },
  };
  pluginCliConfigMock.mockReturnValue(baseConfig);
  setInstalledPluginIndexInstallRecords(installRecords);
  buildPluginSnapshotReportMock.mockReturnValue({
    plugins: [{ id: "alpha", name: "alpha" }],
    diagnostics: [],
  });
  return { baseConfig, installRecords };
}

function indexEntry(pluginId: string, rootDir: string, enabled = true) {
  return {
    pluginId,
    rootDir,
    manifestPath: path.join(rootDir, "openclaw.plugin.json"),
    manifestHash: pluginId,
    origin: "global" as const,
    enabled,
    startup: { sidecar: false, memory: false, agentHarnesses: [] },
    compat: [],
  };
}

describe("plugins cli uninstall", () => {
  beforeEach(async () => {
    resetPluginsCliTestState();
    ({ loadInstalledPluginIndexInstallRecordsSync: readInstallRecords } =
      await import("../plugins/installed-plugin-index-record-reader.js"));
    alphaInstallPath = installedPluginRoot(tempDirs.make("openclaw-cli-uninstall-owned-"), "alpha");
    await fs.mkdir(alphaInstallPath, { recursive: true });
    await fs.writeFile(path.join(alphaInstallPath, "keep.txt"), "owned plugin files");
    const actual =
      await vi.importActual<typeof import("../plugins/uninstall.js")>("../plugins/uninstall.js");
    planPluginUninstallMock.mockImplementation((params) =>
      actual.planPluginUninstall(params as Parameters<typeof actual.planPluginUninstall>[0]),
    );
    applyPluginUninstallDirectoryRemovalMock.mockImplementation(
      actual.applyPluginUninstallDirectoryRemoval,
    );
    configWriteMock.mockImplementation(async (config) => {
      pluginCliConfigMock.mockReturnValue(config as OpenClawConfig);
    });
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    if (ORIGINAL_OPENCLAW_NIX_MODE === undefined) {
      delete process.env.OPENCLAW_NIX_MODE;
    } else {
      process.env.OPENCLAW_NIX_MODE = ORIGINAL_OPENCLAW_NIX_MODE;
    }
  });

  it("shows uninstall dry-run preview without mutating config or acquiring write mode", async () => {
    process.env.OPENCLAW_NIX_MODE = "1";
    const { baseConfig } = configureAlphaInstall();
    pluginCliConfigMock.mockReturnValue({
      ...baseConfig,
      plugins: { ...baseConfig.plugins, slots: { contextEngine: "alpha" } },
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--dry-run"]);

    expect(buildPluginSnapshotReportMock).toHaveBeenCalledTimes(1);
    expect(buildPluginDiagnosticsReportMock).not.toHaveBeenCalled();

    expect(configWriteMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
    expectRuntimeLogIncludes("Dry run, no changes made.");
    expectRuntimeLogIncludes("context engine slot");
  });

  it("forwards online --keep-files without deleting files or writing config locally", async () => {
    configureAlphaInstall();
    resolvePluginLifecycleGatewayMock.mockResolvedValue(pluginLifecycleGatewayMock);
    pluginLifecycleGatewayMock.mockResolvedValue({
      pluginId: "alpha",
      removed: ["plugin settings", "install record"],
      runtime: { generation: 2 },
    });
    await runPluginsCommand(["plugins", "uninstall", "alpha", "--force", "--keep-files"]);
    expect(pluginLifecycleGatewayMock).toHaveBeenCalledWith("plugins.uninstall", {
      pluginId: "alpha",
      keepFiles: true,
    });
    expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("keeps files with the deprecated alias and retains an inherited lease through refresh", async () => {
    configureAlphaInstall();
    const { withPluginLifecycleLease } = await import("../plugins/plugin-lifecycle-lease.js");
    const databasePath = path.join(
      tempDirs.make("openclaw-cli-uninstall-parent-lease-"),
      "state.sqlite",
    );
    const nextConfig = { plugins: { entries: { alpha: { enabled: false } } } };
    await withPluginLifecycleLease({ path: databasePath }, async (lease) => {
      await runPluginsCommand(["plugins", "uninstall", "alpha", "--force", "--keep-config"]);
      lease.assertOwned();
      expect(readInstallRecords()).toEqual({});
      expect(pluginCliConfigMock()).toEqual(nextConfig);
      expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ lease, config: nextConfig }),
      );
      expect(refreshPluginRegistryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: databasePath,
          config: nextConfig,
          installRecords: {},
          reason: "source-changed",
        }),
      );
    });
    expect(promptYesNoMock).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(alphaInstallPath, "keep.txt"), "utf8")).toBe(
      "owned plugin files",
    );
    expectRuntimeLogIncludes("--keep-config");
    expectRuntimeLogIncludes("deprecated");
    expect(configWriteMock).toHaveBeenCalledWith(nextConfig);
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      baseHash: "mock",
      nextConfig,
      writeOptions: expect.objectContaining({
        allowConfigSizeDrop: true,
        auditOrigin: "plugin-install",
        afterWrite: { mode: "restart", reason: "plugin source changed" },
        unsetPaths: [["plugins", "installs"]],
      }),
    });
  });

  it("uninstalls the exact plugin id when an earlier plugin uses it as a display name", async () => {
    const baseConfig = {
      plugins: {
        entries: {
          "unrelated-plugin": { enabled: true },
          calendar: { enabled: true },
        },
        installs: {
          "unrelated-plugin": { source: "npm", spec: "unrelated-plugin@1.0.0" },
          calendar: { source: "npm", spec: "calendar@1.0.0" },
        },
      },
    } as OpenClawConfig;

    pluginCliConfigMock.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(baseConfig.plugins?.installs ?? {});
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [
        { id: "unrelated-plugin", name: "calendar" },
        { id: "calendar", name: "Real Calendar" },
      ],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "uninstall", "calendar", "--force", "--keep-files"]);

    expectInstallRecordsWrittenWithLease(
      {
        "unrelated-plugin": { source: "npm", spec: "unrelated-plugin@1.0.0" },
      },
      {
        plugins: {
          entries: { "unrelated-plugin": { enabled: true }, calendar: { enabled: false } },
        },
      },
    );
  });

  it("rejects an ambiguous display name before planning or mutating installed plugins", async () => {
    const baseConfig = {
      plugins: {
        entries: {
          "calendar-one": { enabled: true },
          "calendar-two": { enabled: true },
        },
        installs: {
          "calendar-one": { source: "npm", spec: "calendar-one@1.0.0" },
          "calendar-two": { source: "npm", spec: "calendar-two@1.0.0" },
        },
      },
    } as OpenClawConfig;

    pluginCliConfigMock.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(baseConfig.plugins?.installs ?? {});
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [
        { id: "calendar-one", name: "calendar" },
        { id: "calendar-two", name: "calendar" },
      ],
      diagnostics: [],
    });

    await expect(
      runPluginsCommand(["plugins", "uninstall", "calendar", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain('Plugin uninstall target "calendar" is ambiguous');

    expect(promptYesNoMock).not.toHaveBeenCalled();
    expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
  });

  it("warns for a versionless scoped ClawHub spec and proceeds", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-claw-plugin-ref-");
    closeOpenClawStateDatabaseForTest();
    try {
      const installRecord = {
        source: "clawhub" as const,
        spec: "clawhub:@owner/audit",
        version: "2.0.1",
        installPath: alphaInstallPath,
      };
      const baseConfig = {
        plugins: {
          entries: { alpha: { enabled: true } },
          installs: { alpha: installRecord },
        },
      } as OpenClawConfig;
      pluginCliConfigMock.mockReturnValue(baseConfig);
      setInstalledPluginIndexInstallRecords({ alpha: installRecord });
      buildPluginSnapshotReportMock.mockReturnValue({
        plugins: [{ id: "alpha", name: "alpha" }],
        diagnostics: [],
      });

      persistClawPackageRef(
        {
          agent: { finalId: "audit-agent" },
          claw: { name: "@owner/audit-claw" },
        } as ClawAddPlan,
        {
          kind: "plugin",
          source: "clawhub",
          ref: "@owner/audit",
          version: "2.0.1",
          integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        { status: "failed" },
      );

      await runPluginsCommand(["plugins", "uninstall", "alpha", "--force", "--keep-files"]);

      expectRuntimeLogIncludes('Warning: plugin "alpha" is referenced by Claw: @owner/audit-claw.');
      expectRuntimeLogIncludes("Uninstalling it may break those Claws");
      expectInstallRecordsWrittenWithLease(
        {},
        { plugins: { entries: { alpha: { enabled: false } } } },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      closeOpenClawStateDatabaseForTest();
    }
  });

  it.each(["closed", "declined", "accepted after config edit"])(
    "handles confirmation that is %s without stale mutations",
    async (confirmation) => {
      const { baseConfig } = configureAlphaInstall();

      if (confirmation === "closed") {
        promptYesNoMock.mockRejectedValueOnce(new PromptInputClosedError());
        await expect(runPluginsCommand(["plugins", "uninstall", "alpha"])).rejects.toThrow(
          "__exit__:1",
        );
        expect(runtimeErrors).toContain(
          "Error: plugins uninstall requires confirmation input. Re-run in an interactive TTY or pass --force.",
        );
      } else if (confirmation === "declined") {
        promptYesNoMock.mockResolvedValueOnce(false);
        await runPluginsCommand(["plugins", "uninstall", "alpha"]);
        expectRuntimeLogIncludes("Cancelled.");
      } else {
        promptYesNoMock.mockImplementationOnce(async () => {
          expect(configWriteMock).not.toHaveBeenCalled();
          expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
          pluginCliConfigMock.mockReturnValue({ ...baseConfig, logging: { level: "debug" } });
          return true;
        });
        await runPluginsCommand(["plugins", "uninstall", "alpha"]);
        expect(pluginCliConfigMock().logging).toEqual({ level: "debug" });
        expect(readInstallRecords()).toEqual({});
        expect(promptYesNoMock).toHaveBeenCalledOnce();
        return;
      }
      expect(readInstallRecords()).toEqual(baseConfig.plugins?.installs);
      expect(await fs.readFile(path.join(alphaInstallPath, "keep.txt"), "utf8")).toBe(
        "owned plugin files",
      );
      expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
      expect(configWriteMock).not.toHaveBeenCalled();
      expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
      expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
    },
  );

  it.each(["disable", "delete", "final commit"])(
    "rechecks persistent authority before %s",
    async (stopAt) => {
      const records = {
        alpha: { source: "npm" as const, spec: "alpha@1.0.0", installPath: alphaInstallPath },
      };
      const config: OpenClawConfig = { plugins: { entries: { alpha: { enabled: true } } } };
      pluginCliConfigMock.mockReturnValue(config);
      setInstalledPluginIndexInstallRecords(records);
      readPersistedInstalledPluginIndexMock.mockResolvedValue(
        createTestInstalledPluginIndex({
          policyHash: "before-uninstall",
          installRecords: records,
        }),
      );
      buildPluginSnapshotReportMock.mockReturnValue({
        plugins: [{ id: "alpha", name: "alpha" }],
        diagnostics: [],
      });
      const failure = new Error("persistent authority closed");
      let removed = false;
      const actual =
        await vi.importActual<typeof import("../plugins/uninstall.js")>("../plugins/uninstall.js");
      applyPluginUninstallDirectoryRemovalMock.mockImplementation(
        async (removal, assertCurrent) => {
          const result = await actual.applyPluginUninstallDirectoryRemoval(removal, assertCurrent);
          removed = result.directoryRemoved;
          return result;
        },
      );
      const { runPluginUninstallCommand } = await import("./plugins-uninstall-command.js");
      await expect(
        runPluginUninstallCommand(["alpha"], {
          force: true,
          beforePersistentApply: () => {
            if (
              stopAt === "disable" ||
              (stopAt === "delete" &&
                pluginCliConfigMock().plugins?.entries?.alpha?.enabled === false) ||
              (stopAt === "final commit" && removed)
            ) {
              throw failure;
            }
          },
        }),
      ).rejects.toBe(failure);

      expect(readInstallRecords()).toEqual(records);
      expect(pluginCliConfigMock().plugins?.entries?.alpha).toEqual({
        enabled: stopAt === "disable",
      });
      expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
      if (stopAt === "final commit") {
        expect(removed).toBe(true);
        await expect(fs.stat(alphaInstallPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(removed).toBe(false);
        expect(await fs.readFile(path.join(alphaInstallPath, "keep.txt"), "utf8")).toBe(
          "owned plugin files",
        );
      }
    },
  );

  it("removes owned aliases before deletion and preserves later edits on retry", async () => {
    const root = await fs.realpath(tempDirs.make("openclaw-cli-uninstall-alias-"));
    const sourcePath = path.join(root, "source");
    const installPath = path.join(root, "extensions", "alpha");
    const aliasPath = path.join(root, "alias");
    const unrelatedPath = path.join(root, "unrelated");
    const addedPath = path.join(root, "added");
    await Promise.all(
      [sourcePath, installPath, unrelatedPath, addedPath].map((dir) =>
        fs.mkdir(dir, { recursive: true }),
      ),
    );
    await fs.symlink(installPath, aliasPath, "dir");
    const installRecords = {
      alpha: { source: "path" as const, sourcePath, installPath },
    };
    let currentConfig: OpenClawConfig = {
      plugins: {
        entries: { alpha: { enabled: true } },
        load: { paths: [aliasPath, unrelatedPath] },
      },
    };
    pluginCliConfigMock.mockImplementation(() => currentConfig);
    configWriteMock.mockImplementation(async (config) => {
      currentConfig = config as OpenClawConfig;
    });
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [
        {
          id: "alpha",
          name: "alpha",
          source: path.join(installPath, "index.js"),
          channelIds: [],
        },
      ],
      diagnostics: [],
    });
    const actual =
      await vi.importActual<typeof import("../plugins/uninstall.js")>("../plugins/uninstall.js");
    let failRemoval = true;
    const { readConfigFileSnapshotForWrite } = await import("../config/config.js");
    const { snapshot } = await readConfigFileSnapshotForWrite();
    applyPluginUninstallDirectoryRemovalMock.mockImplementation(async (removal, assertCurrent) => {
      expect(currentConfig.plugins?.load?.paths).toEqual([unrelatedPath]);
      if (failRemoval) {
        failRemoval = false;
        return { directoryRemoved: false, warnings: ["simulated removal failure"] };
      }
      const result = await actual.applyPluginUninstallDirectoryRemoval(removal, assertCurrent);
      currentConfig = {
        ...currentConfig,
        logging: { level: "debug" },
        plugins: { ...currentConfig.plugins, load: { paths: [unrelatedPath, addedPath] } },
      };
      setPersistedPluginConfig(snapshot.path, currentConfig);
      return result;
    });
    await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "remains disabled and tracked",
    );
    expect(currentConfig.plugins?.entries?.alpha).toEqual({ enabled: false });
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    expect((await fs.stat(installPath)).isDirectory()).toBe(true);

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--force"]);

    expect(currentConfig.plugins?.load?.paths).toEqual([unrelatedPath, addedPath]);
    expect(currentConfig.logging).toEqual({ level: "debug" });
    expect(currentConfig.plugins?.entries?.alpha).toEqual({ enabled: false });
    expect((await fs.stat(sourcePath)).isDirectory()).toBe(true);
    await expect(fs.stat(installPath)).rejects.toMatchObject({ code: "ENOENT" });
    expectInstallRecordsWrittenWithLease({}, currentConfig);
  });

  it("preserves another channel owner during orphan uninstall", async () => {
    const pluginId = "orphan-channel-plugin";
    const installRecords = {
      [pluginId]: {
        source: "path" as const,
        sourcePath: "/tmp/missing-orphan-channel-source",
        installPath: "/tmp/missing-orphan-channel-install",
      },
    };
    const channels = { [pluginId]: { enabled: true }, discord: { enabled: true } };
    pluginCliConfigMock.mockReturnValue({ channels });
    setInstalledPluginIndexInstallRecords(installRecords);
    const installedIndex = await import("../plugins/installed-plugin-index.js");
    const spy = vi.spyOn(installedIndex, "loadInstalledPluginIndex").mockReturnValue(
      createTestInstalledPluginIndex({
        policyHash: "orphan-channel",
        installRecords,
        plugins: [{ ...indexEntry("bridge", "/tmp/bridge"), packageChannel: { id: pluginId } }],
      }),
    );
    try {
      await runPluginsCommand(["plugins", "uninstall", pluginId, "--force", "--keep-files"]);
      expectInstallRecordsWrittenWithLease(
        {},
        {
          channels,
          plugins: { entries: { [pluginId]: { enabled: false } } },
        },
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("cleans declared channels of a disabled singleton without deleting its namesake channel", async () => {
    const installPath = "/tmp/singleton-pack";
    const installRecords = {
      pack: { source: "path", sourcePath: installPath, installPath },
    } as const;
    pluginCliConfigMock.mockReturnValue({
      channels: { chat: { enabled: true }, "pack/one": { enabled: true } },
    } as OpenClawConfig);
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "pack/one", name: "One", status: "disabled", channelIds: ["chat"] }],
      diagnostics: [],
    });
    const installedIndexModule = await import("../plugins/installed-plugin-index.js");
    const indexSpy = vi.spyOn(installedIndexModule, "loadInstalledPluginIndex").mockReturnValue(
      createTestInstalledPluginIndex({
        policyHash: "singleton",
        installRecords,
        plugins: [
          recordInstalledPluginIndexInstallOwner(
            indexEntry("pack/one", installPath, false),
            "pack",
          ),
        ],
      }),
    );
    try {
      await runPluginsCommand(["plugins", "uninstall", "pack/one", "--force", "--keep-files"]);
      expectInstallRecordsWrittenWithLease(
        {},
        {
          channels: { "pack/one": { enabled: true } },
          plugins: { entries: { "pack/one": { enabled: false } } },
        },
      );
    } finally {
      indexSpy.mockRestore();
    }
  });
});
