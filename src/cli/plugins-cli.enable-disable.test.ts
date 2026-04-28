import { beforeEach, describe, expect, it } from "vitest";
import {
  buildPluginSnapshotReport,
  enablePluginInConfig,
  replaceConfigFile,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
} from "./plugins-cli-test-helpers.js";

describe("plugins enable", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("exits non-zero and prints error for nonexistent plugin id", async () => {
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    await expect(
      runPluginsCommand(["plugins", "enable", "totally-fake-plugin-xyz"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("Plugin not found: totally-fake-plugin-xyz");
    expect(runtimeErrors.at(-1)).toContain("openclaw plugins list");
    expect(replaceConfigFile).not.toHaveBeenCalled();
  });

  it("enables a discovered plugin and writes config", async () => {
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [
        {
          id: "my-plugin",
          name: "My Plugin",
          status: "loaded",
          enabled: false,
        },
      ],
      diagnostics: [],
    });
    enablePluginInConfig.mockReturnValue({
      config: { plugins: { entries: { "my-plugin": { enabled: true } } } },
      enabled: true,
    });
    replaceConfigFile.mockResolvedValue(undefined);

    await runPluginsCommand(["plugins", "enable", "my-plugin"]);

    expect(enablePluginInConfig).toHaveBeenCalledWith(expect.anything(), "my-plugin");
    expect(replaceConfigFile).toHaveBeenCalled();
  });
});

describe("plugins disable", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("exits non-zero and prints error for nonexistent plugin id", async () => {
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    await expect(
      runPluginsCommand(["plugins", "disable", "nonexistent-plugin-abc"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("Plugin not found: nonexistent-plugin-abc");
    expect(runtimeErrors.at(-1)).toContain("openclaw plugins list");
    expect(replaceConfigFile).not.toHaveBeenCalled();
  });
});
