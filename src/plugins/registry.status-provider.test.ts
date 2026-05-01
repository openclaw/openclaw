import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { OpenClawPluginApi } from "./types.js";

function createRegistryFixture() {
  return {
    config: {} as OpenClawConfig,
    registry: createPluginRegistry({
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      runtime: {} as PluginRuntime,
    }),
  };
}

function registerVirtualPlugin(params: {
  registry: ReturnType<typeof createPluginRegistry>;
  config: OpenClawConfig;
  id: string;
  name: string;
  register(api: OpenClawPluginApi): void;
}) {
  const record = createPluginRecord({ id: params.id, name: params.name });
  params.registry.registry.plugins.push(record);
  params.register(params.registry.createApi(record, { config: params.config }));
}

describe("status provider registration", () => {
  it("rejects duplicate status provider ids with a diagnostic", () => {
    const { config, registry } = createRegistryFixture();

    registerVirtualPlugin({
      registry,
      config,
      id: "first-plugin",
      name: "First Plugin",
      register(api) {
        api.registerStatusProvider({ id: "contextclaw", getStatus: () => "first" });
      },
    });
    registerVirtualPlugin({
      registry,
      config,
      id: "second-plugin",
      name: "Second Plugin",
      register(api) {
        api.registerStatusProvider({ id: "contextclaw", getStatus: () => "second" });
      },
    });

    expect(registry.registry.statusProviders).toHaveLength(1);
    expect(registry.registry.statusProviders[0]?.pluginId).toBe("first-plugin");
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          pluginId: "second-plugin",
          message: "status provider already registered: contextclaw (first-plugin)",
        }),
      ]),
    );
  });

  it("stores normalized status provider ids", () => {
    const { config, registry } = createRegistryFixture();

    registerVirtualPlugin({
      registry,
      config,
      id: "padded-plugin",
      name: "Padded Plugin",
      register(api) {
        api.registerStatusProvider({ id: " contextclaw ", getStatus: () => "ok" });
      },
    });

    expect(registry.registry.statusProviders).toHaveLength(1);
    expect(registry.registry.statusProviders[0]?.provider.id).toBe("contextclaw");
  });

  it("rejects duplicate normalized status provider ids with a diagnostic", () => {
    const { config, registry } = createRegistryFixture();

    registerVirtualPlugin({
      registry,
      config,
      id: "padded-plugin",
      name: "Padded Plugin",
      register(api) {
        api.registerStatusProvider({ id: " contextclaw ", getStatus: () => "first" });
      },
    });
    registerVirtualPlugin({
      registry,
      config,
      id: "canonical-plugin",
      name: "Canonical Plugin",
      register(api) {
        api.registerStatusProvider({ id: "contextclaw", getStatus: () => "second" });
      },
    });

    expect(registry.registry.statusProviders).toHaveLength(1);
    expect(registry.registry.statusProviders[0]?.provider.id).toBe("contextclaw");
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          pluginId: "canonical-plugin",
          message: "status provider already registered: contextclaw (padded-plugin)",
        }),
      ]),
    );
  });

  it("rejects blank status provider ids with a diagnostic", () => {
    const { config, registry } = createRegistryFixture();

    registerVirtualPlugin({
      registry,
      config,
      id: "blank-plugin",
      name: "Blank Plugin",
      register(api) {
        api.registerStatusProvider({ id: "   ", getStatus: () => "hidden" });
      },
    });

    expect(registry.registry.statusProviders).toHaveLength(0);
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          pluginId: "blank-plugin",
          message: "status provider registration missing id",
        }),
      ]),
    );
  });
});
