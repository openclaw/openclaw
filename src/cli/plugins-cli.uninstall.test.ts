import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { installedPluginRoot } from "../plugin-sdk/test-helpers/bundled-plugin-paths.js";
import { recordInstalledPluginIndexInstallOwner } from "../plugins/installed-plugin-index-install-owner.js";
import type { PluginRecord } from "../plugins/registry.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv } from "../test-utils/env.js";
import * as cli from "./plugins-cli-test-helpers.js";

const {
  applyPluginUninstallDirectoryRemovalMock: removeDirectoryMock,
  readPersistedInstalledPluginIndexMock: readIndexMock,
  createTestInstalledPluginIndex: createIndex,
  restorePersistedInstalledPluginIndexIfCurrentMock: restoreIndexMock,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock: writeRecordsMock,
  expectNoPluginCliCalls: expectNoCalls,
} = cli;

let alphaInstallPath: string;
let actual: typeof import("../plugins/uninstall.js");
let readInstallRecords: (typeof import("../plugins/installed-plugin-index-record-reader.js"))["loadInstalledPluginIndexInstallRecordsSync"];
const originalEnv = captureEnv(["OPENCLAW_NIX_MODE"]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const uninstall = (...args: string[]) => cli.runPluginCli("uninstall", ...args);

function setPluginSnapshot(
  ...plugins: Array<
    Pick<PluginRecord, "id" | "name"> &
      Partial<Pick<PluginRecord, "source" | "status" | "channelIds">>
  >
) {
  cli.buildPluginSnapshotReportMock.mockReturnValue({ plugins, diagnostics: [] });
}

async function expectFilesKept() {
  expect(await fs.readFile(path.join(alphaInstallPath, "keep.txt"), "utf8")).toBe(
    "owned plugin files",
  );
}

function configureNamedPlugins(plugins: Array<{ id: string; name: string }>) {
  const installs = Object.fromEntries(
    plugins.map(({ id }) => [id, { source: "npm" as const, spec: `${id}@1.0.0` }]),
  );
  cli.pluginCliConfigMock.mockReturnValue({
    plugins: {
      entries: Object.fromEntries(plugins.map(({ id }) => [id, { enabled: true }])),
      installs,
    },
  });
  cli.setInstalledPluginIndexInstallRecords(installs);
  setPluginSnapshot(...plugins);
}

function expectRuntimeLogIncludes(fragment: string) {
  expect(cli.pluginsCliRuntimeLogs.join("\n")).toContain(fragment);
}

function expectRecords(records: unknown, config: unknown) {
  expect(writeRecordsMock).toHaveBeenCalledWith(
    records,
    expect.objectContaining({
      config,
      filePath: expect.any(String),
      lease: expect.anything(),
    }),
  );
}

function configureAlphaInstall() {
  const installRecords = {
    alpha: { source: "path" as const, sourcePath: alphaInstallPath, installPath: alphaInstallPath },
  };
  const baseConfig: OpenClawConfig = {
    plugins: { entries: { alpha: { enabled: true } }, installs: installRecords },
  };
  cli.pluginCliConfigMock.mockReturnValue(baseConfig);
  cli.setInstalledPluginIndexInstallRecords(installRecords);
  setPluginSnapshot({ id: "alpha", name: "alpha" });
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

beforeEach(async () => {
  cli.resetPluginsCliTestState();
  ({ loadInstalledPluginIndexInstallRecordsSync: readInstallRecords } =
    await import("../plugins/installed-plugin-index-record-reader.js"));
  alphaInstallPath = installedPluginRoot(tempDirs.make("openclaw-cli-uninstall-owned-"), "alpha");
  await fs.mkdir(alphaInstallPath, { recursive: true });
  await fs.writeFile(path.join(alphaInstallPath, "keep.txt"), "owned plugin files");
  actual =
    await vi.importActual<typeof import("../plugins/uninstall.js")>("../plugins/uninstall.js");
  cli.planPluginUninstallMock.mockImplementation((params) =>
    actual.planPluginUninstall(params as Parameters<typeof actual.planPluginUninstall>[0]),
  );
  removeDirectoryMock.mockImplementation(actual.applyPluginUninstallDirectoryRemoval);
  cli.configWriteMock.mockImplementation(async (config) => {
    cli.pluginCliConfigMock.mockReturnValue(config as OpenClawConfig);
  });
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  originalEnv.restore();
});

it("shows uninstall dry-run preview without mutating config or acquiring write mode", async () => {
  process.env.OPENCLAW_NIX_MODE = "1";
  const { baseConfig } = configureAlphaInstall();
  cli.pluginCliConfigMock.mockReturnValue({
    ...baseConfig,
    plugins: { ...baseConfig.plugins, slots: { contextEngine: "alpha" } },
  });

  await uninstall("alpha", "--dry-run");

  expect(cli.buildPluginSnapshotReportMock).toHaveBeenCalledTimes(1);
  expect(cli.buildPluginDiagnosticsReportMock).not.toHaveBeenCalled();

  expectNoCalls(cli.configWriteMock, cli.refreshPluginRegistryMock);
  expectRuntimeLogIncludes("Dry run, no changes made.");
  expectRuntimeLogIncludes("context engine slot");
});

it("escapes terminal controls from the installed manifest name in the preview", async () => {
  configureAlphaInstall();
  setPluginSnapshot({ id: "alpha", name: "alpha\u001b[31m\nforged-row" });

  await uninstall("alpha", "--dry-run");

  const output = cli.pluginsCliRuntimeLogs.join("\n");
  expect(output).not.toContain("\u001b");
  expect(output).toContain("Plugin: alpha\\nforged-row (alpha)");
});

it("forwards online --keep-files without deleting files or writing config locally", async () => {
  configureAlphaInstall();
  cli.resolvePluginLifecycleGatewayMock.mockResolvedValue(cli.pluginLifecycleGatewayMock);
  cli.pluginLifecycleGatewayMock.mockResolvedValue({
    pluginId: "alpha",
    removed: ["plugin settings", "install record"],
    runtime: { generation: 2 },
  });
  await uninstall("alpha", "--force", "--keep-files");
  expect(cli.pluginLifecycleGatewayMock).toHaveBeenCalledWith("plugins.uninstall", {
    pluginId: "alpha",
    keepFiles: true,
  });
  expectNoCalls(removeDirectoryMock, cli.configWriteMock);
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
    await uninstall("alpha", "--force", "--keep-config");
    lease.assertOwned();
    expect(readInstallRecords()).toEqual({});
    expect(cli.pluginCliConfigMock()).toEqual(nextConfig);
    expect(writeRecordsMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        lease: {
          databasePath,
          stateLease: expect.toSatisfy((stateLease: unknown) => stateLease === lease.stateLease),
          assertCurrent: expect.any(Function),
          assertOwned: expect.any(Function),
        },
        config: nextConfig,
      }),
    );
    expect(cli.refreshPluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: databasePath,
        config: nextConfig,
        installRecords: {},
        reason: "source-changed",
      }),
    );
  });
  expect(cli.promptYesNoMock).not.toHaveBeenCalled();
  await expectFilesKept();
  expectRuntimeLogIncludes("--keep-config");
  expectRuntimeLogIncludes("deprecated");
  expect(cli.configWriteMock).toHaveBeenCalledWith(nextConfig);
  expect(cli.replaceConfigFileMock).toHaveBeenCalledWith({
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
  configureNamedPlugins([
    { id: "unrelated-plugin", name: "calendar" },
    { id: "calendar", name: "Real Calendar" },
  ]);
  await uninstall("calendar", "--force", "--keep-files");

  expectRecords(
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
  configureNamedPlugins([
    { id: "calendar-one", name: "calendar" },
    { id: "calendar-two", name: "calendar" },
  ]);
  await expect(uninstall("calendar", "--force")).rejects.toThrow("__exit__:1");

  expect(cli.runtimeErrors.at(-1)).toContain('Plugin uninstall target "calendar" is ambiguous');

  expectNoCalls(
    cli.promptYesNoMock,
    removeDirectoryMock,
    writeRecordsMock,
    cli.configWriteMock,
    cli.refreshPluginRegistryMock,
  );
});

it.each(["closed", "declined", "accepted after config edit"])(
  "handles confirmation that is %s without stale mutations",
  async (confirmation) => {
    const { baseConfig } = configureAlphaInstall();

    if (confirmation === "closed") {
      cli.promptYesNoMock.mockRejectedValueOnce(new cli.PromptInputClosedError());
      await expect(uninstall("alpha")).rejects.toThrow("__exit__:1");
      expect(cli.runtimeErrors).toContain(
        "Error: plugins uninstall requires confirmation input. Re-run in an interactive TTY or pass --force.",
      );
    } else if (confirmation === "declined") {
      cli.promptYesNoMock.mockResolvedValueOnce(false);
      await uninstall("alpha");
      expectRuntimeLogIncludes("Cancelled.");
    } else {
      cli.promptYesNoMock.mockImplementationOnce(async () => {
        expectNoCalls(cli.configWriteMock, removeDirectoryMock);
        cli.pluginCliConfigMock.mockReturnValue({ ...baseConfig, logging: { level: "debug" } });
        return true;
      });
      await uninstall("alpha");
      expect(cli.pluginCliConfigMock().logging).toEqual({ level: "debug" });
      expect(readInstallRecords()).toEqual({});
      expect(cli.promptYesNoMock).toHaveBeenCalledOnce();
      return;
    }
    expect(readInstallRecords()).toEqual(baseConfig.plugins?.installs);
    await expectFilesKept();
    expectNoCalls(
      writeRecordsMock,
      cli.configWriteMock,
      cli.refreshPluginRegistryMock,
      removeDirectoryMock,
    );
  },
);

it("restores install records when the config write rejects during uninstall", async () => {
  const { installRecords } = configureAlphaInstall();
  const previousPersistedIndex = createIndex({
    policyHash: "previous-policy",
    installRecords,
  });

  readIndexMock.mockResolvedValue(previousPersistedIndex);

  cli.replaceConfigFileMock.mockRejectedValueOnce(new Error("config changed"));

  await expect(uninstall("alpha", "--force", "--keep-files")).rejects.toThrow("config changed");

  expectRecords({}, { plugins: { entries: { alpha: { enabled: false } } } });
  expect(restoreIndexMock).toHaveBeenCalledWith(
    previousPersistedIndex,
    expect.any(Number),
    expect.objectContaining({
      filePath: expect.any(String),
      lease: expect.anything(),
    }),
  );
  expectNoCalls(cli.refreshPluginRegistryMock, removeDirectoryMock);
});

it.each(["disable", "delete", "final commit"])(
  "rechecks persistent authority before %s",
  async (stopAt) => {
    const records = {
      alpha: { source: "npm" as const, spec: "alpha@1.0.0", installPath: alphaInstallPath },
    };
    const config: OpenClawConfig = { plugins: { entries: { alpha: { enabled: true } } } };
    cli.pluginCliConfigMock.mockReturnValue(config);
    cli.setInstalledPluginIndexInstallRecords(records);
    readIndexMock.mockResolvedValue(
      createIndex({
        policyHash: "before-uninstall",
        installRecords: records,
      }),
    );
    setPluginSnapshot({ id: "alpha", name: "alpha" });
    const failure = new Error("persistent authority closed");
    let removed = false;
    removeDirectoryMock.mockImplementation(async (removal, assertCurrent) => {
      const result = await actual.applyPluginUninstallDirectoryRemoval(removal, assertCurrent);
      removed = result.directoryRemoved;
      return result;
    });
    const { runPluginUninstallCommand } = await import("./plugins-uninstall-command.js");
    await expect(
      runPluginUninstallCommand(["alpha"], {
        force: true,
        beforePersistentApply: () => {
          if (
            stopAt === "disable" ||
            (stopAt === "delete" &&
              cli.pluginCliConfigMock().plugins?.entries?.alpha?.enabled === false) ||
            (stopAt === "final commit" && removed)
          ) {
            throw failure;
          }
        },
      }),
    ).rejects.toBe(failure);

    expect(readInstallRecords()).toEqual(records);
    expect(cli.pluginCliConfigMock().plugins?.entries?.alpha).toEqual({
      enabled: stopAt === "disable",
    });
    expect(cli.refreshPluginRegistryMock).not.toHaveBeenCalled();
    if (stopAt === "final commit") {
      expect(removed).toBe(true);
      await expect(fs.stat(alphaInstallPath)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(removed).toBe(false);
      await expectFilesKept();
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
  cli.pluginCliConfigMock.mockImplementation(() => currentConfig);
  cli.configWriteMock.mockImplementation(async (config) => {
    currentConfig = config as OpenClawConfig;
  });
  cli.setInstalledPluginIndexInstallRecords(installRecords);
  setPluginSnapshot({
    id: "alpha",
    name: "alpha",
    source: path.join(installPath, "index.js"),
    channelIds: [],
  });
  let failRemoval = true;
  const { readConfigFileSnapshotForWrite } = await import("../config/config.js");
  const { snapshot } = await readConfigFileSnapshotForWrite();
  removeDirectoryMock.mockImplementation(async (removal, assertCurrent) => {
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
    cli.setPersistedPluginConfig(snapshot.path, currentConfig);
    return result;
  });
  await expect(uninstall("alpha", "--force")).rejects.toThrow("remains disabled and tracked");
  expect(currentConfig.plugins?.entries?.alpha).toEqual({ enabled: false });
  expect(writeRecordsMock).not.toHaveBeenCalled();
  expect((await fs.stat(installPath)).isDirectory()).toBe(true);

  await uninstall("alpha", "--force");

  expect(currentConfig.plugins?.load?.paths).toEqual([unrelatedPath, addedPath]);
  expect(currentConfig.logging).toEqual({ level: "debug" });
  expect(currentConfig.plugins?.entries?.alpha).toEqual({ enabled: false });
  expect((await fs.stat(sourcePath)).isDirectory()).toBe(true);
  await expect(fs.stat(installPath)).rejects.toMatchObject({ code: "ENOENT" });
  expectRecords({}, currentConfig);
});

it.each(["orphan with another channel owner", "disabled singleton with namesake channel"])(
  "preserves unrelated channels for %s",
  async (scenario) => {
    const orphan = scenario.startsWith("orphan");
    const pluginId = orphan ? "orphan-channel-plugin" : "pack/one";
    const installPath = orphan ? "/tmp/missing-orphan-channel-install" : "/tmp/singleton-pack";
    const owner = orphan ? pluginId : "pack";
    const installRecords = {
      [owner]: {
        source: "path" as const,
        sourcePath: orphan ? "/tmp/missing-orphan-channel-source" : installPath,
        installPath,
      },
    };
    const channels = orphan
      ? { [pluginId]: { enabled: true }, discord: { enabled: true } }
      : { chat: { enabled: true }, [pluginId]: { enabled: true } };
    cli.pluginCliConfigMock.mockReturnValue({ channels });
    cli.setInstalledPluginIndexInstallRecords(installRecords);
    if (!orphan) {
      setPluginSnapshot({ id: pluginId, name: "One", status: "disabled", channelIds: ["chat"] });
    }
    const plugin = orphan
      ? { ...indexEntry("bridge", "/tmp/bridge"), packageChannel: { id: pluginId } }
      : recordInstalledPluginIndexInstallOwner(indexEntry(pluginId, installPath, false), owner);
    const installedIndex = await import("../plugins/installed-plugin-index.js");
    using indexSpy = vi.spyOn(installedIndex, "loadInstalledPluginIndex").mockReturnValue(
      createIndex({
        policyHash: scenario,
        installRecords,
        plugins: [plugin],
      }),
    );
    await uninstall(pluginId, "--force", "--keep-files");
    expect(indexSpy).toHaveBeenCalled();
    expectRecords(
      {},
      {
        channels: orphan ? channels : { [pluginId]: { enabled: true } },
        plugins: { entries: { [pluginId]: { enabled: false } } },
      },
    );
  },
);
