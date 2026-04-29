import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildPluginSnapshotReport,
  enablePluginInConfig,
  loadConfig,
  runtimeErrors,
  refreshPluginRegistry,
  resetPluginsCliTestState,
  runPluginsCommand,
  writeConfigFile,
} from "./plugins-cli-test-helpers.js";

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
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "Alpha" }],
      diagnostics: [],
    });
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
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "Alpha" }],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "disable", "alpha"]);

    const nextConfig = writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;
    expect(nextConfig.plugins?.entries?.alpha?.enabled).toBe(false);
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: nextConfig,
      installRecords: {},
      reason: "policy-changed",
    });
  });

  it("fails without mutating config when enabling an unknown plugin id", async () => {
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "Alpha" }],
      diagnostics: [],
    });

    await expect(runPluginsCommand(["plugins", "enable", "missing-plugin"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expect(enablePluginInConfig).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Plugin not found: missing-plugin. Run `openclaw plugins list` to see installed plugins.",
    );
  });

  it("fails without mutating config when disabling an unknown plugin id", async () => {
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "Alpha" }],
      diagnostics: [],
    });

    await expect(runPluginsCommand(["plugins", "disable", "missing-plugin"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Plugin not found: missing-plugin. Run `openclaw plugins list` to see installed plugins.",
    );
  });
});
