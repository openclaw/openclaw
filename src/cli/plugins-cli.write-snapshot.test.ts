import fs from "node:fs";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const writeOptions = {
    expectedConfigPath: "/tmp/openclaw.json",
    envSnapshotForRestore: { TEST_ENV: "1" },
  };
  return {
    writeOptions,
    loadConfig: vi.fn(() => ({})),
    readConfigFileSnapshotForWrite: vi.fn(async () => ({
      snapshot: {
        valid: true,
        path: "/tmp/openclaw.json",
        resolved: { channels: { telegram: { dmPolicy: "open" } }, plugins: {} },
        issues: [],
      },
      writeOptions,
    })),
    writeConfigFile: vi.fn(async () => {}),
    enablePluginInConfig: vi.fn(
      (
        cfg: Record<string, unknown>,
      ): { config: Record<string, unknown>; enabled: boolean; reason?: string } => ({
        config: cfg,
        enabled: true,
      }),
    ),
    setPluginEnabledInConfig: vi.fn(
      (cfg: Record<string, unknown>, id: string, enabled: boolean) => ({
        ...cfg,
        plugins: { entries: { [id]: { enabled } } },
      }),
    ),
    resolveStateDir: vi.fn(() => "/tmp/state"),
    buildPluginStatusReport: vi.fn(() => ({ plugins: [], diagnostics: [], workspaceDir: "/tmp" })),
    installPluginFromNpmSpec: vi.fn(),
    installPluginFromPath: vi.fn(),
    theme: {
      muted: (s: string) => s,
      heading: (s: string) => s,
      success: (s: string) => s,
      warn: (s: string) => s,
      error: (s: string) => s,
      command: (s: string) => s,
    },
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
    },
  };
});

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  readConfigFileSnapshotForWrite: mocks.readConfigFileSnapshotForWrite,
  writeConfigFile: mocks.writeConfigFile,
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: mocks.resolveStateDir,
}));

vi.mock("./plugins-config.js", () => ({
  setPluginEnabledInConfig: mocks.setPluginEnabledInConfig,
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginStatusReport: mocks.buildPluginStatusReport,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

vi.mock("../terminal/theme.js", () => ({
  theme: mocks.theme,
}));

vi.mock("../terminal/links.js", () => ({
  formatDocsLink: () => "docs",
}));

vi.mock("../terminal/table.js", () => ({
  renderTable: () => "",
}));

vi.mock("../plugins/enable.js", () => ({
  enablePluginInConfig: mocks.enablePluginInConfig,
}));

vi.mock("../plugins/install.js", () => ({
  installPluginFromNpmSpec: mocks.installPluginFromNpmSpec,
  installPluginFromPath: mocks.installPluginFromPath,
}));

vi.mock("../plugins/installs.js", () => ({
  recordPluginInstall: (cfg: Record<string, unknown>) => cfg,
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  clearPluginManifestRegistryCache: vi.fn(),
}));

vi.mock("../plugins/slots.js", () => ({
  applyExclusiveSlotSelection: ({ config }: { config: Record<string, unknown> }) => ({
    config,
    warnings: [],
  }),
}));

vi.mock("../plugins/source-display.js", () => ({
  resolvePluginSourceRoots: vi.fn(() => ({})),
  formatPluginSourceForTable: vi.fn(() => ({ value: "", rootKey: null })),
}));

vi.mock("../plugins/uninstall.js", () => ({
  resolveUninstallDirectoryTarget: vi.fn(() => null),
  uninstallPlugin: vi.fn(),
}));

vi.mock("../plugins/update.js", () => ({
  updateNpmInstalledPlugins: vi.fn(),
}));

vi.mock("../utils.js", () => ({
  resolveUserPath: (s: string) => s,
  shortenHomeInString: (s: string) => s,
  shortenHomePath: (s: string) => s,
}));

vi.mock("./npm-resolution.js", () => ({
  resolvePinnedNpmInstallRecordForCli: vi.fn(() => ({})),
}));

vi.mock("./prompt.js", () => ({
  promptYesNo: vi.fn(async () => true),
}));

import { registerPluginsCli } from "./plugins-cli.js";

describe("plugins-cli config writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses readConfigFileSnapshotForWrite + write options for disable", async () => {
    const program = new Command();
    registerPluginsCli(program);

    await program.parseAsync(["plugins", "disable", "demo"], {
      from: "user",
    });

    expect(mocks.readConfigFileSnapshotForWrite).toHaveBeenCalledTimes(1);
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: { telegram: { dmPolicy: "open" } },
        plugins: { entries: { demo: { enabled: false } } },
      }),
      mocks.writeOptions,
    );
  });

  it("preserves enable guard behavior and logs warning when enable is denied", async () => {
    mocks.enablePluginInConfig.mockReturnValueOnce({
      config: { channels: { telegram: { dmPolicy: "open" } }, plugins: {} },
      enabled: false,
      reason: "blocked by denylist",
    });
    const program = new Command();
    registerPluginsCli(program);

    await program.parseAsync(["plugins", "enable", "demo"], {
      from: "user",
    });

    expect(mocks.readConfigFileSnapshotForWrite).toHaveBeenCalledTimes(1);
    expect(mocks.enablePluginInConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: { telegram: { dmPolicy: "open" } },
      }),
      "demo",
    );
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: { telegram: { dmPolicy: "open" } },
      }),
      mocks.writeOptions,
    );
    expect(mocks.runtime.log).toHaveBeenCalledWith(
      'Plugin "demo" could not be enabled (blocked by denylist).',
    );
  });

  it("uses readConfigFileSnapshotForWrite + write options for install --link", async () => {
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    try {
      mocks.installPluginFromPath.mockResolvedValueOnce({
        ok: true,
        pluginId: "demo",
        version: "1.2.3",
      });

      const program = new Command();
      registerPluginsCli(program);

      await program.parseAsync(["plugins", "install", "--link", "/some/path"], {
        from: "user",
      });

      expect(mocks.readConfigFileSnapshotForWrite).toHaveBeenCalledTimes(1);
      expect(mocks.loadConfig).not.toHaveBeenCalled();
      expect(mocks.installPluginFromPath).toHaveBeenCalledWith({
        path: "/some/path",
        dryRun: true,
      });
      expect(mocks.writeConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          channels: { telegram: { dmPolicy: "open" } },
          plugins: expect.objectContaining({
            load: {
              paths: ["/some/path"],
            },
          }),
        }),
        mocks.writeOptions,
      );
    } finally {
      existsSpy.mockRestore();
    }
  });
});
