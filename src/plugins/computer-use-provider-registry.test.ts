/** Tests Computer Use provider manifest ownership and runtime descriptor registration. */
import { describe, expect, it } from "vitest";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";

function createTestRegistry() {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
}

function createOwner(id: string, computerUseProviders: string[] = []) {
  return createPluginRecord({
    id,
    name: id,
    source: `/tmp/${id}/index.js`,
    origin: "global",
    enabled: true,
    contracts: { computerUseProviders },
    configSchema: false,
  });
}

describe("Computer Use provider registry", () => {
  it("registers a normalized descriptor declared by the manifest", () => {
    const pluginRegistry = createTestRegistry();

    pluginRegistry.registerComputerUseProvider(createOwner("driver", ["native-desktop"]), {
      id: " Native-Desktop ",
      label: " Native Desktop ",
    });

    expect(pluginRegistry.registry.computerUseProviders.get("native-desktop")).toEqual({
      pluginId: "driver",
      pluginName: "driver",
      provider: { id: "native-desktop", label: "Native Desktop" },
      source: "/tmp/driver/index.js",
      rootDir: undefined,
    });
  });

  it("rejects registrations missing manifest ownership", () => {
    const pluginRegistry = createTestRegistry();

    pluginRegistry.registerComputerUseProvider(createOwner("driver"), {
      id: "native-desktop",
      label: "Native Desktop",
    });

    expect(pluginRegistry.registry.computerUseProviders.size).toBe(0);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "driver",
        message: "plugin must declare contracts.computerUseProviders for provider: native-desktop",
      }),
    );
  });

  it("rejects invalid descriptors and normalized duplicate ids", () => {
    const pluginRegistry = createTestRegistry();
    pluginRegistry.registerComputerUseProvider(createOwner("invalid", ["native-desktop"]), {
      id: "native-desktop",
      label: " ",
    });
    pluginRegistry.registerComputerUseProvider(createOwner("first", ["native-desktop"]), {
      id: "Native-Desktop",
      label: "First",
    });
    pluginRegistry.registerComputerUseProvider(createOwner("second", ["native-desktop"]), {
      id: " native-desktop ",
      label: "Second",
    });

    expect(pluginRegistry.registry.computerUseProviders.size).toBe(1);
    expect(pluginRegistry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "invalid",
          message: 'Computer Use provider "native-desktop" registration missing label',
        }),
        expect.objectContaining({
          pluginId: "second",
          message: "Computer Use provider already registered: native-desktop (first)",
        }),
      ]),
    );
  });
});
