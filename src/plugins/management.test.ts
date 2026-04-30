import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshotForWrite: vi.fn(),
  replaceConfigFile: vi.fn(),
  loadInstalledPluginIndexInstallRecords: vi.fn(),
  writePersistedInstalledPluginIndexInstallRecords: vi.fn(),
  refreshPluginRegistry: vi.fn(),
  resolveDefaultPluginExtensionsDir: vi.fn(),
  buildPluginSnapshotReport: vi.fn(),
  buildPluginDiagnosticsReport: vi.fn(),
  buildPluginCompatibilityNotices: vi.fn(),
  buildPluginInspectReport: vi.fn(),
  planPluginUninstall: vi.fn(),
  applyPluginUninstallDirectoryRemoval: vi.fn(),
  updateNpmInstalledPlugins: vi.fn(),
  enablePluginInConfig: vi.fn(),
  setPluginEnabledInConfig: vi.fn(),
  applySlotSelectionForPlugin: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshotForWrite: mocks.readConfigFileSnapshotForWrite,
  replaceConfigFile: mocks.replaceConfigFile,
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./installed-plugin-index-records.js")>();
  return {
    ...actual,
    loadInstalledPluginIndexInstallRecords: mocks.loadInstalledPluginIndexInstallRecords,
    writePersistedInstalledPluginIndexInstallRecords:
      mocks.writePersistedInstalledPluginIndexInstallRecords,
  };
});

vi.mock("./plugin-registry.js", () => ({
  inspectPluginRegistry: vi.fn(),
  refreshPluginRegistry: mocks.refreshPluginRegistry,
}));

vi.mock("./install-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./install-paths.js")>();
  return {
    ...actual,
    resolveDefaultPluginExtensionsDir: mocks.resolveDefaultPluginExtensionsDir,
  };
});

vi.mock("./status.js", () => ({
  buildPluginSnapshotReport: mocks.buildPluginSnapshotReport,
  buildPluginDiagnosticsReport: mocks.buildPluginDiagnosticsReport,
  buildPluginCompatibilityNotices: mocks.buildPluginCompatibilityNotices,
  buildPluginInspectReport: mocks.buildPluginInspectReport,
}));

vi.mock("./uninstall.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./uninstall.js")>();
  return {
    ...actual,
    planPluginUninstall: mocks.planPluginUninstall,
    applyPluginUninstallDirectoryRemoval: mocks.applyPluginUninstallDirectoryRemoval,
  };
});

vi.mock("./update.js", () => ({
  updateNpmInstalledPlugins: mocks.updateNpmInstalledPlugins,
}));

vi.mock("./enable.js", () => ({
  enablePluginInConfig: mocks.enablePluginInConfig,
}));

vi.mock("./toggle-config.js", () => ({
  setPluginEnabledInConfig: mocks.setPluginEnabledInConfig,
}));

vi.mock("./slot-selection.js", () => ({
  applySlotSelectionForPlugin: mocks.applySlotSelectionForPlugin,
}));

const { setManagedPluginEnabled, uninstallManagedPlugin, updateManagedPlugins } =
  await import("./management.js");

function configSnapshot(config = {}) {
  return {
    snapshot: {
      valid: true,
      hash: "config-1",
      sourceConfig: config,
    },
    writeOptions: {},
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("plugin management service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfigFileSnapshotForWrite.mockResolvedValue(configSnapshot());
    mocks.replaceConfigFile.mockResolvedValue(undefined);
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    mocks.writePersistedInstalledPluginIndexInstallRecords.mockResolvedValue(undefined);
    mocks.refreshPluginRegistry.mockResolvedValue({ plugins: [], diagnostics: [] });
    mocks.resolveDefaultPluginExtensionsDir.mockReturnValue("/config/extensions");
    mocks.buildPluginSnapshotReport.mockReturnValue({
      plugins: [{ id: "demo", name: "demo", status: "loaded", channelIds: [] }],
      diagnostics: [],
    });
    mocks.buildPluginDiagnosticsReport.mockReturnValue({ plugins: [], diagnostics: [] });
    mocks.buildPluginCompatibilityNotices.mockReturnValue([]);
    mocks.buildPluginInspectReport.mockReturnValue(null);
    mocks.planPluginUninstall.mockReturnValue({
      ok: true,
      config: {},
      pluginId: "demo",
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        channelConfig: false,
        directory: false,
      },
      directoryRemoval: null,
    });
    mocks.applyPluginUninstallDirectoryRemoval.mockResolvedValue({
      directoryRemoved: false,
      warnings: [],
    });
    mocks.updateNpmInstalledPlugins.mockResolvedValue({
      config: {},
      changed: false,
      outcomes: [],
    });
    mocks.enablePluginInConfig.mockImplementation((cfg, pluginId) => ({
      config: { ...cfg, enabledPluginId: pluginId },
      enabled: true,
    }));
    mocks.setPluginEnabledInConfig.mockImplementation((cfg, pluginId, enabled) => ({
      ...cfg,
      plugins: { entries: { [pluginId]: { enabled } } },
    }));
    mocks.applySlotSelectionForPlugin.mockImplementation((config) => ({ config, warnings: [] }));
  });

  it("uses the canonical plugin extensions dir when uninstalling", async () => {
    mocks.readConfigFileSnapshotForWrite.mockResolvedValue(
      configSnapshot({
        plugins: {
          installs: {
            demo: { source: "npm", spec: "demo", installPath: "/config/extensions/demo" },
          },
        },
      }),
    );
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      demo: { source: "npm", spec: "demo", installPath: "/config/extensions/demo" },
    });

    await uninstallManagedPlugin({ id: "demo", force: true });

    expect(mocks.planPluginUninstall).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionsDir: "/config/extensions",
      }),
    );
  });

  it("serializes concurrent plugin config mutations", async () => {
    const firstWrite = deferred();
    let firstWriteStarted: (() => void) | undefined;
    const firstWriteStartedPromise = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    mocks.replaceConfigFile.mockImplementationOnce(async () => {
      firstWriteStarted?.();
      await firstWrite.promise;
    });

    const first = setManagedPluginEnabled({ id: "first", enabled: false });
    const second = setManagedPluginEnabled({ id: "second", enabled: false });

    await firstWriteStartedPromise;
    await Promise.resolve();

    expect(mocks.readConfigFileSnapshotForWrite).toHaveBeenCalledTimes(1);

    firstWrite.resolve();
    await Promise.all([first, second]);

    expect(mocks.readConfigFileSnapshotForWrite).toHaveBeenCalledTimes(2);
  });

  it("returns partial success when plugin updates commit before later failures", async () => {
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      first: { source: "npm", spec: "first", installPath: "/config/extensions/first" },
      second: { source: "npm", spec: "second", installPath: "/config/extensions/second" },
    });
    mocks.updateNpmInstalledPlugins.mockResolvedValue({
      config: {
        plugins: {
          installs: {
            first: { source: "npm", spec: "first", installPath: "/config/extensions/first" },
          },
        },
      },
      changed: true,
      outcomes: [
        { pluginId: "first", status: "updated", message: "Updated first." },
        { pluginId: "second", status: "error", message: "Failed to update second." },
      ],
    });

    const result = await updateManagedPlugins({ all: true });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        changed: true,
        partialFailure: true,
      }),
    );
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({
      first: { source: "npm", spec: "first", installPath: "/config/extensions/first" },
    });
    expect(mocks.replaceConfigFile).toHaveBeenCalled();
    expect(mocks.refreshPluginRegistry).toHaveBeenCalled();
  });
});
