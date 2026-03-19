import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const loadConfig = vi.fn<() => OpenClawConfig>(() => ({}) as OpenClawConfig);
const writeConfigFile = vi.fn<(config: OpenClawConfig) => Promise<void>>(async () => undefined);
const resolveStateDir = vi.fn(() => "/tmp/openclaw-state");
const installPluginFromMarketplace = vi.fn();
const listMarketplacePlugins = vi.fn();
const resolveMarketplaceInstallShortcut = vi.fn();
const enablePluginInConfig = vi.fn();
const recordPluginInstall = vi.fn();
const clearPluginManifestRegistryCache = vi.fn();
const buildPluginStatusReport = vi.fn();
const applyExclusiveSlotSelection = vi.fn();
const uninstallPlugin = vi.fn();
const updateNpmInstalledPlugins = vi.fn();
const promptYesNo = vi.fn();
const installPluginFromNpmSpec = vi.fn();
const installPluginFromPath = vi.fn();

const { defaultRuntime, runtimeLogs, runtimeErrors, resetRuntimeCapture } =
  createCliRuntimeCapture();

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => loadConfig(),
    writeConfigFile: (config: OpenClawConfig) => writeConfigFile(config),
  };
});

vi.mock("../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/paths.js")>();
  return {
    ...actual,
    resolveStateDir: () => resolveStateDir(),
  };
});

vi.mock("../plugins/marketplace.js", () => ({
  installPluginFromMarketplace: (...args: unknown[]) => installPluginFromMarketplace(...args),
  listMarketplacePlugins: (...args: unknown[]) => listMarketplacePlugins(...args),
  resolveMarketplaceInstallShortcut: (...args: unknown[]) =>
    resolveMarketplaceInstallShortcut(...args),
}));

vi.mock("../plugins/enable.js", () => ({
  enablePluginInConfig: (...args: unknown[]) => enablePluginInConfig(...args),
}));

vi.mock("../plugins/installs.js", () => ({
  recordPluginInstall: (...args: unknown[]) => recordPluginInstall(...args),
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  clearPluginManifestRegistryCache: () => clearPluginManifestRegistryCache(),
}));

vi.mock("../plugins/status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/status.js")>();
  return {
    ...actual,
    buildPluginStatusReport: (...args: unknown[]) => buildPluginStatusReport(...args),
  };
});

vi.mock("../plugins/slots.js", () => ({
  applyExclusiveSlotSelection: (...args: unknown[]) => applyExclusiveSlotSelection(...args),
}));

vi.mock("../plugins/uninstall.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/uninstall.js")>();
  return {
    ...actual,
    uninstallPlugin: (...args: unknown[]) => uninstallPlugin(...args),
  };
});

vi.mock("../plugins/update.js", () => ({
  updateNpmInstalledPlugins: (...args: unknown[]) => updateNpmInstalledPlugins(...args),
}));

vi.mock("./prompt.js", () => ({
  promptYesNo: (...args: unknown[]) => promptYesNo(...args),
}));

vi.mock("../plugins/install.js", () => ({
  installPluginFromNpmSpec: (...args: unknown[]) => installPluginFromNpmSpec(...args),
  installPluginFromPath: (...args: unknown[]) => installPluginFromPath(...args),
}));

const { registerPluginsCli } = await import("./plugins-cli.js");

describe("plugins cli", () => {
  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerPluginsCli(program);
    return program;
  };

  const runCommand = (argv: string[]) => createProgram().parseAsync(argv, { from: "user" });

  beforeEach(() => {
    resetRuntimeCapture();
    loadConfig.mockReset();
    writeConfigFile.mockReset();
    resolveStateDir.mockReset();
    installPluginFromMarketplace.mockReset();
    listMarketplacePlugins.mockReset();
    resolveMarketplaceInstallShortcut.mockReset();
    enablePluginInConfig.mockReset();
    recordPluginInstall.mockReset();
    clearPluginManifestRegistryCache.mockReset();
    buildPluginStatusReport.mockReset();
    applyExclusiveSlotSelection.mockReset();
    uninstallPlugin.mockReset();
    updateNpmInstalledPlugins.mockReset();
    promptYesNo.mockReset();
    installPluginFromNpmSpec.mockReset();
    installPluginFromPath.mockReset();

    loadConfig.mockReturnValue({} as OpenClawConfig);
    writeConfigFile.mockResolvedValue(undefined);
    resolveStateDir.mockReturnValue("/tmp/openclaw-state");
    resolveMarketplaceInstallShortcut.mockResolvedValue(null);
    installPluginFromMarketplace.mockResolvedValue({
      ok: false,
      error: "marketplace install failed",
    });
    enablePluginInConfig.mockImplementation((cfg: OpenClawConfig) => ({ config: cfg }));
    recordPluginInstall.mockImplementation((cfg: OpenClawConfig) => cfg);
    buildPluginStatusReport.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    applyExclusiveSlotSelection.mockImplementation(({ config }: { config: OpenClawConfig }) => ({
      config,
      warnings: [],
    }));
    uninstallPlugin.mockResolvedValue({
      ok: true,
      config: {} as OpenClawConfig,
      warnings: [],
      actions: {
        entry: false,
        install: false,
        allowlist: false,
        loadPath: false,
        memorySlot: false,
        directory: false,
      },
    });
    updateNpmInstalledPlugins.mockResolvedValue({
      outcomes: [],
      changed: false,
      config: {} as OpenClawConfig,
    });
    promptYesNo.mockResolvedValue(true);
    installPluginFromPath.mockResolvedValue({ ok: false, error: "path install disabled in test" });
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error: "npm install disabled in test",
    });
  });

  it("exits when --marketplace is combined with --link", async () => {
    await expect(
      runCommand(["plugins", "install", "alpha", "--marketplace", "local/repo", "--link"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("`--link` is not supported with `--marketplace`.");
    expect(installPluginFromMarketplace).not.toHaveBeenCalled();
  });

  it("exits when marketplace install fails", async () => {
    await expect(
      runCommand(["plugins", "install", "alpha", "--marketplace", "local/repo"]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "local/repo",
        plugin: "alpha",
      }),
    );
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("installs marketplace plugins and persists config", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = {
      plugins: {
        entries: {
          alpha: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;
    const installedCfg = {
      ...enabledCfg,
      plugins: {
        ...enabledCfg.plugins,
        installs: {
          alpha: {
            source: "marketplace",
            installPath: "/tmp/openclaw-state/extensions/alpha",
          },
        },
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(cfg);
    installPluginFromMarketplace.mockResolvedValue({
      ok: true,
      pluginId: "alpha",
      targetDir: "/tmp/openclaw-state/extensions/alpha",
      version: "1.2.3",
      marketplaceName: "Claude",
      marketplaceSource: "local/repo",
      marketplacePlugin: "alpha",
    });
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(installedCfg);
    buildPluginStatusReport.mockReturnValue({
      plugins: [{ id: "alpha", kind: "provider" }],
      diagnostics: [],
    });
    applyExclusiveSlotSelection.mockReturnValue({
      config: installedCfg,
      warnings: ["slot adjusted"],
    });

    await runCommand(["plugins", "install", "alpha", "--marketplace", "local/repo"]);

    expect(clearPluginManifestRegistryCache).toHaveBeenCalledTimes(1);
    expect(writeConfigFile).toHaveBeenCalledWith(installedCfg);
    expect(runtimeLogs.some((line) => line.includes("slot adjusted"))).toBe(true);
    expect(runtimeLogs.some((line) => line.includes("Installed plugin: alpha"))).toBe(true);
  });

  it("shows uninstall dry-run preview without mutating config", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          alpha: {
            enabled: true,
          },
        },
        installs: {
          alpha: {
            source: "path",
            sourcePath: "/tmp/openclaw-state/extensions/alpha",
            installPath: "/tmp/openclaw-state/extensions/alpha",
          },
        },
      },
    } as OpenClawConfig);
    buildPluginStatusReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });

    await runCommand(["plugins", "uninstall", "alpha", "--dry-run"]);

    expect(uninstallPlugin).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(runtimeLogs.some((line) => line.includes("Dry run, no changes made."))).toBe(true);
  });

  it("uninstalls with --force and --keep-files without prompting", async () => {
    const baseConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
        installs: {
          alpha: {
            source: "path",
            sourcePath: "/tmp/openclaw-state/extensions/alpha",
            installPath: "/tmp/openclaw-state/extensions/alpha",
          },
        },
      },
    } as OpenClawConfig;
    const nextConfig = {
      plugins: {
        entries: {},
        installs: {},
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(baseConfig);
    buildPluginStatusReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    uninstallPlugin.mockResolvedValue({
      ok: true,
      config: nextConfig,
      warnings: [],
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        loadPath: false,
        memorySlot: false,
        directory: false,
      },
    });

    await runCommand(["plugins", "uninstall", "alpha", "--force", "--keep-files"]);

    expect(promptYesNo).not.toHaveBeenCalled();
    expect(uninstallPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "alpha",
        deleteFiles: false,
      }),
    );
    expect(writeConfigFile).toHaveBeenCalledWith(nextConfig);
  });

  it("exits when uninstall target is not managed by plugin install records", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        entries: {},
        installs: {},
      },
    } as OpenClawConfig);
    buildPluginStatusReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });

    await expect(runCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain("is not managed by plugins config/install records");
    expect(uninstallPlugin).not.toHaveBeenCalled();
  });

  it("exits when update is called without id and without --all", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        installs: {},
      },
    } as OpenClawConfig);

    await expect(runCommand(["plugins", "update"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("Provide a plugin id or use --all.");
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
  });

  it("reports no tracked plugins when update --all has empty install records", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        installs: {},
      },
    } as OpenClawConfig);

    await runCommand(["plugins", "update", "--all"]);

    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(runtimeLogs.at(-1)).toBe("No tracked plugins to update.");
  });

  it("maps an explicit unscoped npm dist-tag update to the tracked plugin id", async () => {
    const config = {
      plugins: {
        installs: {
          "openclaw-codex-app-server": {
            source: "npm",
            spec: "openclaw-codex-app-server",
            installPath: "/tmp/openclaw-codex-app-server",
            resolvedName: "openclaw-codex-app-server",
          },
        },
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue(config);
    updateNpmInstalledPlugins.mockResolvedValue({
      config,
      changed: false,
      outcomes: [],
    });

    await runCommand(["plugins", "update", "openclaw-codex-app-server@beta"]);

    expect(updateNpmInstalledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        pluginIds: ["openclaw-codex-app-server"],
        specOverrides: {
          "openclaw-codex-app-server": "openclaw-codex-app-server@beta",
        },
      }),
    );
  });

  it("maps an explicit scoped npm dist-tag update to the tracked plugin id", async () => {
    const config = {
      plugins: {
        installs: {
          "voice-call": {
            source: "npm",
            spec: "@openclaw/voice-call",
            installPath: "/tmp/voice-call",
            resolvedName: "@openclaw/voice-call",
          },
        },
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue(config);
    updateNpmInstalledPlugins.mockResolvedValue({
      config,
      changed: false,
      outcomes: [],
    });

    await runCommand(["plugins", "update", "@openclaw/voice-call@beta"]);

    expect(updateNpmInstalledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        pluginIds: ["voice-call"],
        specOverrides: {
          "voice-call": "@openclaw/voice-call@beta",
        },
      }),
    );
  });

  it("maps an explicit npm version update to the tracked plugin id", async () => {
    const config = {
      plugins: {
        installs: {
          "openclaw-codex-app-server": {
            source: "npm",
            spec: "openclaw-codex-app-server",
            installPath: "/tmp/openclaw-codex-app-server",
            resolvedName: "openclaw-codex-app-server",
          },
        },
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue(config);
    updateNpmInstalledPlugins.mockResolvedValue({
      config,
      changed: false,
      outcomes: [],
    });

    await runCommand(["plugins", "update", "openclaw-codex-app-server@0.2.0-beta.4"]);

    expect(updateNpmInstalledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        pluginIds: ["openclaw-codex-app-server"],
        specOverrides: {
          "openclaw-codex-app-server": "openclaw-codex-app-server@0.2.0-beta.4",
        },
      }),
    );
  });

  it("keeps using the recorded npm tag when update is invoked by plugin id", async () => {
    const config = {
      plugins: {
        installs: {
          "openclaw-codex-app-server": {
            source: "npm",
            spec: "openclaw-codex-app-server@beta",
            installPath: "/tmp/openclaw-codex-app-server",
            resolvedName: "openclaw-codex-app-server",
          },
        },
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue(config);
    updateNpmInstalledPlugins.mockResolvedValue({
      config,
      changed: false,
      outcomes: [],
    });

    await runCommand(["plugins", "update", "openclaw-codex-app-server"]);

    expect(updateNpmInstalledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        pluginIds: ["openclaw-codex-app-server"],
      }),
    );
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalledWith(
      expect.objectContaining({
        specOverrides: expect.anything(),
      }),
    );
  });

  it("writes updated config when updater reports changes", async () => {
    const cfg = {
      plugins: {
        installs: {
          alpha: {
            source: "npm",
            spec: "@openclaw/alpha@1.0.0",
          },
        },
      },
    } as OpenClawConfig;
    const nextConfig = {
      plugins: {
        installs: {
          alpha: {
            source: "npm",
            spec: "@openclaw/alpha@1.1.0",
          },
        },
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue(cfg);
    updateNpmInstalledPlugins.mockResolvedValue({
      outcomes: [{ status: "ok", message: "Updated alpha -> 1.1.0" }],
      changed: true,
      config: nextConfig,
    });

    await runCommand(["plugins", "update", "alpha"]);

    expect(updateNpmInstalledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        pluginIds: ["alpha"],
        dryRun: false,
      }),
    );
    expect(writeConfigFile).toHaveBeenCalledWith(nextConfig);
    expect(runtimeLogs.some((line) => line.includes("Restart the gateway to load plugins."))).toBe(
      true,
    );
  });
});
