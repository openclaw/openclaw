import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
let registerPluginCliCommands: typeof import("./cli.js").registerPluginCliCommands;
let clearPluginLoaderCache: typeof import("./loader.js").clearPluginLoaderCache;
let clearPluginManifestRegistryCache: typeof import("./manifest-registry.js").clearPluginManifestRegistryCache;
let resetPluginRuntimeStateForTest: typeof import("./runtime.js").resetPluginRuntimeStateForTest;

function resetPluginState() {
  clearPluginLoaderCache();
  clearPluginManifestRegistryCache();
  resetPluginRuntimeStateForTest();
}

describe("registerPluginCliCommands browser plugin integration", () => {
  beforeEach(async () => {
    ({ clearPluginLoaderCache } =
      await vi.importActual<typeof import("./loader.js")>("./loader.js"));
    ({ clearPluginManifestRegistryCache } =
      await vi.importActual<typeof import("./manifest-registry.js")>("./manifest-registry.js"));
    ({ resetPluginRuntimeStateForTest } =
      await vi.importActual<typeof import("./runtime.js")>("./runtime.js"));
    ({ registerPluginCliCommands } = await vi.importActual<typeof import("./cli.js")>("./cli.js"));
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
