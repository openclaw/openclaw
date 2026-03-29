import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  ensurePluginRegistryLoaded,
  hasPluginUpdatedHooks,
  loadConfig,
  resetPluginsCliTestState,
  runPluginUpdatedForPlugin,
  runPluginsCommand,
  runtimeErrors,
  runtimeLogs,
  updateNpmInstalledHookPacks,
  updateNpmInstalledPlugins,
  writeConfigFile,
} from "./plugins-cli-test-helpers.js";

describe("plugins cli update", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("updates tracked hook packs through plugins update", async () => {
    const cfg = {
      hooks: {
        internal: {
          installs: {
            "demo-hooks": {
              source: "npm",
              spec: "@acme/demo-hooks@1.0.0",
              installPath: "/tmp/hooks/demo-hooks",
              resolvedName: "@acme/demo-hooks",
            },
          },
        },
      },
    } as OpenClawConfig;
    const nextConfig = {
      hooks: {
        internal: {
          installs: {
            "demo-hooks": {
              source: "npm",
              spec: "@acme/demo-hooks@1.1.0",
              installPath: "/tmp/hooks/demo-hooks",
            },
          },
        },
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(cfg);
    updateNpmInstalledPlugins.mockResolvedValue({
      config: cfg,
      changed: false,
      outcomes: [],
    });
    updateNpmInstalledHookPacks.mockResolvedValue({
      config: nextConfig,
      changed: true,
      outcomes: [
        {
          hookId: "demo-hooks",
          status: "updated",
          message: 'Updated hook pack "demo-hooks": 1.0.0 -> 1.1.0.',
        },
      ],
    });

    await runPluginsCommand(["plugins", "update", "demo-hooks"]);

    expect(updateNpmInstalledHookPacks).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        hookIds: ["demo-hooks"],
      }),
    );
    expect(writeConfigFile).toHaveBeenCalledWith(nextConfig);
    expect(
      runtimeLogs.some((line) => line.includes("Restart the gateway to load plugins and hooks.")),
    ).toBe(true);
  });

  it("exits when update is called without id and without --all", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        installs: {},
      },
    } as OpenClawConfig);

    await expect(runPluginsCommand(["plugins", "update"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("Provide a plugin or hook-pack id, or use --all.");
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
  });

  it("reports no tracked plugins or hook packs when update --all has empty install records", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        installs: {},
      },
    } as OpenClawConfig);

    await runPluginsCommand(["plugins", "update", "--all"]);

    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(runtimeLogs.at(-1)).toBe("No tracked plugins or hook packs to update.");
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

    await runPluginsCommand(["plugins", "update", "openclaw-codex-app-server@beta"]);

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

    await runPluginsCommand(["plugins", "update", "@openclaw/voice-call@beta"]);

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

    await runPluginsCommand(["plugins", "update", "openclaw-codex-app-server@0.2.0-beta.4"]);

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

    await runPluginsCommand(["plugins", "update", "openclaw-codex-app-server"]);

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
    updateNpmInstalledHookPacks.mockResolvedValue({
      outcomes: [],
      changed: false,
      config: nextConfig,
    });

    await runPluginsCommand(["plugins", "update", "alpha"]);

    expect(updateNpmInstalledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        pluginIds: ["alpha"],
        dryRun: false,
      }),
    );
    expect(writeConfigFile).toHaveBeenCalledWith(nextConfig);
    expect(
      runtimeLogs.some((line) => line.includes("Restart the gateway to load plugins and hooks.")),
    ).toBe(true);
  });

  it("runs plugin_updated lifecycle hooks for updated plugins", async () => {
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
            installPath: "/tmp/alpha",
            version: "1.1.0",
          },
        },
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue(cfg);
    hasPluginUpdatedHooks.mockReturnValue(true);
    updateNpmInstalledPlugins.mockImplementation(async (params: unknown) => {
      const opts = params as {
        onPluginUpdated?: (event: {
          pluginId: string;
          requestedPluginId: string;
          source: "npm";
          spec: string;
          previousVersion: string;
          nextVersion: string;
          installPath: string;
        }) => Promise<void> | void;
      };
      await opts.onPluginUpdated?.({
        pluginId: "alpha",
        requestedPluginId: "alpha",
        source: "npm",
        spec: "@openclaw/alpha@1.1.0",
        previousVersion: "1.0.0",
        nextVersion: "1.1.0",
        installPath: "/tmp/alpha",
      });
      return {
        outcomes: [{ pluginId: "alpha", status: "updated", message: "Updated alpha" }],
        changed: true,
        config: nextConfig,
      };
    });
    updateNpmInstalledHookPacks.mockResolvedValue({
      outcomes: [],
      changed: false,
      config: nextConfig,
    });

    await runPluginsCommand(["plugins", "update", "alpha"]);

    expect(ensurePluginRegistryLoaded).toHaveBeenCalledWith({ scope: "all" });
    expect(runPluginUpdatedForPlugin).toHaveBeenCalledWith(
      "alpha",
      {
        pluginId: "alpha",
        requestedPluginId: "alpha",
        source: "npm",
        spec: "@openclaw/alpha@1.1.0",
        previousVersion: "1.0.0",
        nextVersion: "1.1.0",
        installPath: "/tmp/alpha",
      },
      { trigger: "plugins_update" },
    );
  });
});
