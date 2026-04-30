import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildPluginRegistrySnapshotReport,
  defaultRuntime,
  enablePluginInConfig,
  loadConfig,
  refreshPluginRegistry,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeLogs,
  writeConfigFile,
} from "./plugins-cli-test-helpers.js";

function withDiscoveredPlugin(id: string) {
  buildPluginRegistrySnapshotReport.mockReturnValue({
    plugins: [{ id, name: id, enabled: false, status: "disabled" }],
    diagnostics: [],
    registrySource: "derived",
    registryDiagnostics: [],
  });
}

describe("plugins cli policy mutations", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("refreshes the persisted plugin registry after enabling a plugin", async () => {
    const enabledConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue({} as OpenClawConfig);
    withDiscoveredPlugin("alpha");
    enablePluginInConfig.mockReturnValue({
      config: enabledConfig,
      enabled: true,
    });

    await runPluginsCommand(["plugins", "enable", "alpha"]);

    expect(writeConfigFile).toHaveBeenCalledWith(enabledConfig);
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: enabledConfig,
      installRecords: {},
      reason: "policy-changed",
    });
  });

  it("refreshes the persisted plugin registry after disabling a plugin", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig);
    withDiscoveredPlugin("alpha");

    await runPluginsCommand(["plugins", "disable", "alpha"]);

    const nextConfig = writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;
    expect(nextConfig.plugins?.entries?.alpha?.enabled).toBe(false);
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: nextConfig,
      installRecords: {},
      reason: "policy-changed",
    });
  });

  // Regression for #73551: enabling/disabling a plugin id that isn't in the
  // discovered registry used to write `plugins.entries.<id>: { enabled: ... }`
  // and exit 0 with a "success" message. The fix gates both subcommands on
  // the registry and exits non-zero without touching config.
  it("rejects `plugins enable` for an unknown plugin id without writing config", async () => {
    loadConfig.mockReturnValue({} as OpenClawConfig);
    // Default mock returns `plugins: []` — no discovered plugins.

    await expect(
      runPluginsCommand(["plugins", "enable", "totally-fake-plugin-xyz"]),
    ).rejects.toThrow("__exit__:1");

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expect(enablePluginInConfig).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(runtimeLogs.join("\n")).toContain("Plugin not found: totally-fake-plugin-xyz");
  });

  it("rejects `plugins disable` for an unknown plugin id without writing config", async () => {
    loadConfig.mockReturnValue({} as OpenClawConfig);

    await expect(
      runPluginsCommand(["plugins", "disable", "totally-fake-plugin-xyz"]),
    ).rejects.toThrow("__exit__:1");

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(runtimeLogs.join("\n")).toContain("Plugin not found: totally-fake-plugin-xyz");
  });
});
