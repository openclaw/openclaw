import { beforeEach, describe, expect, it } from "vitest";
import { installedPluginRoot } from "../../test/helpers/bundled-plugin-paths.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyExclusiveSlotSelection,
  buildPluginDiagnosticsReport,
  clearPluginManifestRegistryCache,
  enablePluginInConfig,
  installHooksFromNpmSpec,
  installPluginFromClawHub,
  installPluginFromMarketplace,
  installPluginFromNpmSpec,
  loadConfig,
  readConfigFileSnapshot,
  parseClawHubPluginSpec,
  recordHookInstall,
  recordPluginInstall,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  runtimeLogs,
  writeConfigFile,
} from "./plugins-cli-test-helpers.js";

const CLI_STATE_ROOT = "/tmp/openclaw-state";

function cliInstallPath(pluginId: string): string {
  return installedPluginRoot(CLI_STATE_ROOT, pluginId);
}

function createEnabledPluginConfig(pluginId: string): OpenClawConfig {
  return {
    plugins: {
      entries: {
        [pluginId]: {
          enabled: true,
        },
      },
    },
  } as OpenClawConfig;
}

function createClawHubInstalledConfig(params: {
  pluginId: string;
  install: Record<string, unknown>;
}): OpenClawConfig {
  const enabledCfg = createEnabledPluginConfig(params.pluginId);
  return {
    ...enabledCfg,
    plugins: {
      ...enabledCfg.plugins,
      installs: {
        [params.pluginId]: params.install,
      },
    },
  } as OpenClawConfig;
}

function createClawHubInstallResult(params: {
  pluginId: string;
  packageName: string;
  version: string;
  channel: string;
}): Awaited<ReturnType<typeof installPluginFromClawHub>> {
  return {
    ok: true,
    pluginId: params.pluginId,
    targetDir: cliInstallPath(params.pluginId),
    version: params.version,
    packageName: params.packageName,
    clawhub: {
      source: "clawhub",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: params.packageName,
      clawhubFamily: "code-plugin",
      clawhubChannel: params.channel,
      version: params.version,
      integrity: "sha256-abc",
      resolvedAt: "2026-03-22T00:00:00.000Z",
    },
  };
}

describe("plugins cli install", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("shows the force overwrite option in install help", async () => {
    const { Command } = await import("commander");
    const { registerPluginsCli } = await import("./plugins-cli.js");
    const program = new Command();
    registerPluginsCli(program);

    const pluginsCommand = program.commands.find((command) => command.name() === "plugins");
    const installCommand = pluginsCommand?.commands.find((command) => command.name() === "install");
    const helpText = installCommand?.helpInformation() ?? "";

    expect(helpText).toContain("--force");
    expect(helpText).toContain("Overwrite an existing installed plugin or");
    expect(helpText).toContain("hook pack");
  });

  it("exits when --marketplace is combined with --link", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo", "--link"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("`--link` is not supported with `--marketplace`.");
    expect(installPluginFromMarketplace).not.toHaveBeenCalled();
  });

  it("exits when marketplace install fails", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo"]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "local/repo",
        plugin: "alpha",
      }),
    );
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("fails closed for unrelated invalid config before installer side effects", async () => {
    const invalidConfigErr = new Error("config invalid");
    (invalidConfigErr as { code?: string }).code = "INVALID_CONFIG";
    loadConfig.mockImplementation(() => {
      throw invalidConfigErr;
    });
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw-config.json5",
      exists: true,
      raw: '{ "models": { "default": 123 } }',
      parsed: { models: { default: 123 } },
      resolved: { models: { default: 123 } },
      valid: false,
      config: { models: { default: 123 } },
      hash: "mock",
      issues: [{ path: "models.default", message: "invalid model ref" }],
      warnings: [],
      legacyIssues: [],
    });

    await expect(runPluginsCommand(["plugins", "install", "alpha"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain(
      "Config invalid; run `openclaw doctor --fix` before installing plugins.",
    );
    expect(installPluginFromMarketplace).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
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
            installPath: cliInstallPath("alpha"),
          },
        },
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(cfg);
    installPluginFromMarketplace.mockResolvedValue({
      ok: true,
      pluginId: "alpha",
      targetDir: cliInstallPath("alpha"),
      extensions: ["index.js"],
      version: "1.2.3",
      marketplaceName: "Claude",
      marketplaceSource: "local/repo",
      marketplacePlugin: "alpha",
    });
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(installedCfg);
    buildPluginDiagnosticsReport.mockReturnValue({
      plugins: [{ id: "alpha", kind: "provider" }],
      diagnostics: [],
    });
    applyExclusiveSlotSelection.mockReturnValue({
      config: installedCfg,
      warnings: ["slot adjusted"],
    });

    await runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo"]);

    expect(clearPluginManifestRegistryCache).toHaveBeenCalledTimes(1);
    expect(writeConfigFile).toHaveBeenCalledWith(installedCfg);
    expect(runtimeLogs.some((line) => line.includes("slot adjusted"))).toBe(true);
    expect(runtimeLogs.some((line) => line.includes("Installed plugin: alpha"))).toBe(true);
  });

  it("passes force through as overwrite mode for marketplace installs", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "local/repo",
        plugin: "alpha",
        mode: "update",
      }),
    );
  });

  it("installs ClawHub plugins and persists source metadata", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");
    const installedCfg = createClawHubInstalledConfig({
      pluginId: "demo",
      install: {
        source: "clawhub",
        spec: "clawhub:demo@1.2.3",
        installPath: cliInstallPath("demo"),
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
      },
    });

    loadConfig.mockReturnValue(cfg);
    parseClawHubPluginSpec.mockReturnValue({ name: "demo" });
    installPluginFromClawHub.mockResolvedValue(
      createClawHubInstallResult({
        pluginId: "demo",
        packageName: "demo",
        version: "1.2.3",
        channel: "official",
      }),
    );
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(installedCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: installedCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "clawhub:demo"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
      }),
    );
    expect(recordPluginInstall).toHaveBeenCalledWith(
      enabledCfg,
      expect.objectContaining({
        pluginId: "demo",
        source: "clawhub",
        spec: "clawhub:demo@1.2.3",
        clawhubPackage: "demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
      }),
    );
    expect(writeConfigFile).toHaveBeenCalledWith(installedCfg);
    expect(runtimeLogs.some((line) => line.includes("Installed plugin: demo"))).toBe(true);
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
  });

  it("passes force through as overwrite mode for ClawHub installs", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");

    loadConfig.mockReturnValue(cfg);
    parseClawHubPluginSpec.mockReturnValue({ name: "demo" });
    installPluginFromClawHub.mockResolvedValue(
      createClawHubInstallResult({
        pluginId: "demo",
        packageName: "demo",
        version: "1.2.3",
        channel: "official",
      }),
    );
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "clawhub:demo", "--force"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
        mode: "update",
      }),
    );
  });

  it("prefers ClawHub before npm for bare plugin specs", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");
    const installedCfg = createClawHubInstalledConfig({
      pluginId: "demo",
      install: {
        source: "clawhub",
        spec: "clawhub:demo@1.2.3",
        installPath: cliInstallPath("demo"),
        clawhubPackage: "demo",
      },
    });

    loadConfig.mockReturnValue(cfg);
    installPluginFromClawHub.mockResolvedValue(
      createClawHubInstallResult({
        pluginId: "demo",
        packageName: "demo",
        version: "1.2.3",
        channel: "community",
      }),
    );
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(installedCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: installedCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "demo"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
      }),
    );
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(writeConfigFile).toHaveBeenCalledWith(installedCfg);
  });

  it("falls back to npm when ClawHub does not have the package", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = {
      plugins: {
        entries: {
          demo: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(cfg);
    installPluginFromClawHub.mockResolvedValue({
      ok: false,
      error: "ClawHub /api/v1/packages/demo failed (404): Package not found",
      code: "package_not_found",
    });
    installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: cliInstallPath("demo"),
      version: "1.2.3",
      npmResolution: {
        packageName: "demo",
        resolvedVersion: "1.2.3",
        tarballUrl: "https://registry.npmjs.org/demo/-/demo-1.2.3.tgz",
      },
    });
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "demo"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
      }),
    );
    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "demo",
      }),
    );
  });

  it("passes dangerous force unsafe install to marketplace installs", async () => {
    await expect(
      runPluginsCommand([
        "plugins",
        "install",
        "alpha",
        "--marketplace",
        "local/repo",
        "--dangerously-force-unsafe-install",
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "local/repo",
        plugin: "alpha",
        dangerouslyForceUnsafeInstall: true,
      }),
    );
  });

  it("passes dangerous force unsafe install to npm installs", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");

    loadConfig.mockReturnValue(cfg);
    installPluginFromClawHub.mockResolvedValue({
      ok: false,
      error: "ClawHub /api/v1/packages/demo failed (404): Package not found",
      code: "package_not_found",
    });
    installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: cliInstallPath("demo"),
      version: "1.2.3",
      npmResolution: {
        packageName: "demo",
        resolvedVersion: "1.2.3",
        tarballUrl: "https://registry.npmjs.org/demo/-/demo-1.2.3.tgz",
      },
    });
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "demo", "--dangerously-force-unsafe-install"]);

    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "demo",
        dangerouslyForceUnsafeInstall: true,
      }),
    );
  });

  it("passes force through as overwrite mode for npm installs", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");

    loadConfig.mockReturnValue(cfg);
    installPluginFromClawHub.mockResolvedValue({
      ok: false,
      error: "ClawHub /api/v1/packages/demo failed (404): Package not found",
      code: "package_not_found",
    });
    installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: cliInstallPath("demo"),
      version: "1.2.3",
      npmResolution: {
        packageName: "demo",
        resolvedVersion: "1.2.3",
        tarballUrl: "https://registry.npmjs.org/demo/-/demo-1.2.3.tgz",
      },
    });
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "demo", "--force"]);

    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "demo",
        mode: "update",
      }),
    );
  });

  it("does not fall back to npm when ClawHub rejects a real package", async () => {
    installPluginFromClawHub.mockResolvedValue({
      ok: false,
      error: 'Use "openclaw skills install demo" instead.',
      code: "skill_package",
    });

    await expect(runPluginsCommand(["plugins", "install", "demo"])).rejects.toThrow("__exit__:1");

    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain('Use "openclaw skills install demo" instead.');
  });

  it("falls back to installing hook packs from npm specs", async () => {
    const cfg = {} as OpenClawConfig;
    const installedCfg = {
      hooks: {
        internal: {
          installs: {
            "demo-hooks": {
              source: "npm",
              spec: "@acme/demo-hooks@1.2.3",
            },
          },
        },
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(cfg);
    installPluginFromClawHub.mockResolvedValue({
      ok: false,
      error: "ClawHub /api/v1/packages/@acme/demo-hooks failed (404): Package not found",
      code: "package_not_found",
    });
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.plugin.json",
    });
    installHooksFromNpmSpec.mockResolvedValue({
      ok: true,
      hookPackId: "demo-hooks",
      hooks: ["command-audit"],
      targetDir: "/tmp/hooks/demo-hooks",
      version: "1.2.3",
      npmResolution: {
        name: "@acme/demo-hooks",
        spec: "@acme/demo-hooks@1.2.3",
        integrity: "sha256-demo",
      },
    });
    recordHookInstall.mockReturnValue(installedCfg);

    await runPluginsCommand(["plugins", "install", "@acme/demo-hooks"]);

    expect(installHooksFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@acme/demo-hooks",
      }),
    );
    expect(recordHookInstall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        hookId: "demo-hooks",
        hooks: ["command-audit"],
      }),
    );
    expect(writeConfigFile).toHaveBeenCalledWith(installedCfg);
    expect(runtimeLogs.some((line) => line.includes("Installed hook pack: demo-hooks"))).toBe(true);
  });

  it("passes force through as overwrite mode for hook-pack npm fallback installs", async () => {
    const cfg = {} as OpenClawConfig;
    const installedCfg = {
      hooks: {
        internal: {
          installs: {
            "demo-hooks": {
              source: "npm",
              spec: "@acme/demo-hooks@1.2.3",
            },
          },
        },
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(cfg);
    installPluginFromClawHub.mockResolvedValue({
      ok: false,
      error: "ClawHub /api/v1/packages/@acme/demo-hooks failed (404): Package not found",
      code: "package_not_found",
    });
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.plugin.json",
    });
    installHooksFromNpmSpec.mockResolvedValue({
      ok: true,
      hookPackId: "demo-hooks",
      hooks: ["command-audit"],
      targetDir: "/tmp/hooks/demo-hooks",
      version: "1.2.3",
      npmResolution: {
        name: "@acme/demo-hooks",
        spec: "@acme/demo-hooks@1.2.3",
        integrity: "sha256-demo",
      },
    });
    recordHookInstall.mockReturnValue(installedCfg);

    await runPluginsCommand(["plugins", "install", "@acme/demo-hooks", "--force"]);

    expect(installHooksFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@acme/demo-hooks",
        mode: "update",
      }),
    );
  });
});
