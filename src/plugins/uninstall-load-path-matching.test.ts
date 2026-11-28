import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { removePluginFromConfig } from "./uninstall-config.js";

// mock-isolation: pure config mutation; no plugin runtime, filesystem, or network access.

type PluginConfig = NonNullable<OpenClawConfig["plugins"]>;
type PluginInstallRecord = NonNullable<PluginConfig["installs"]>[string];

function pathInstallRecord(installPath = "/path/to/plugin"): PluginInstallRecord {
  return {
    source: "path",
    sourcePath: installPath,
    installPath,
  };
}

function configWithLoadPaths(loadPaths: string[]): OpenClawConfig {
  return {
    plugins: {
      installs: { "my-plugin": pathInstallRecord() },
      load: { paths: loadPaths },
    },
  };
}

describe("removePluginFromConfig home-relative load paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("removes the load path that expands to the install path", () => {
    vi.stubEnv("HOME", "/path/to");
    const { config, actions } = removePluginFromConfig(
      configWithLoadPaths(["~/plugin", "/other/path"]),
      "my-plugin",
    );
    expect(config.plugins?.load?.paths).toEqual(["/other/path"]);
    expect(actions.loadPath).toBe(true);
  });

  it("keeps home-relative load paths owned by other plugins", () => {
    vi.stubEnv("HOME", "/path/to");
    const loadPaths = ["~/plugins/other-plugin", "~/plugin-x"];
    const { config, actions } = removePluginFromConfig(configWithLoadPaths(loadPaths), "my-plugin");
    expect(config.plugins?.load?.paths).toEqual(loadPaths);
    expect(actions.loadPath).toBe(false);
  });
});
