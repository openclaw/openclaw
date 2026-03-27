import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { registerPluginCliCommands } from "./cli.js";
import { clearPluginLoaderCache } from "./loader.js";
import { clearPluginManifestRegistryCache } from "./manifest-registry.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

function resetPluginState() {
  clearPluginLoaderCache();
  clearPluginManifestRegistryCache();
  resetPluginRuntimeStateForTest();
}

describe("registerPluginCliCommands browser plugin integration", () => {
  beforeEach(() => {
    resetPluginState();
  });

  afterEach(() => {
    resetPluginState();
  });

  it("registers the browser command from the bundled browser plugin", () => {
    const program = new Command();
    registerPluginCliCommands(
      program,
      {
        plugins: {
          allow: ["browser"],
        },
      } as OpenClawConfig,
      undefined,
      { pluginSdkResolution: "dist" },
    );

    expect(program.commands.map((command) => command.name())).toContain("browser");
  });

  it("omits the browser command when the bundled browser plugin is disabled", () => {
    const program = new Command();
    registerPluginCliCommands(
      program,
      {
        plugins: {
          allow: ["browser"],
          entries: {
            browser: {
              enabled: false,
            },
          },
        },
      } as OpenClawConfig,
      undefined,
      { pluginSdkResolution: "dist" },
    );

    expect(program.commands.map((command) => command.name())).not.toContain("browser");
  });
});
