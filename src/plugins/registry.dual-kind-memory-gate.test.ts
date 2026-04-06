import { afterEach, describe, expect, it } from "vitest";
import { createPluginRegistryFixture, registerTestPlugin } from "./contracts/testkit.js";
import { clearMemoryEmbeddingProviders } from "./memory-embedding-providers.js";
import { _resetMemoryPluginState, getMemoryRuntime } from "./memory-state.js";
import { createPluginRecord } from "./status.test-helpers.js";

afterEach(() => {
  _resetMemoryPluginState();
  clearMemoryEmbeddingProviders();
});

function createStubMemoryRuntime() {
  return {
    async getMemorySearchManager() {
      return { manager: null, error: "missing" } as const;
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" as const };
    },
  };
}

describe("dual-kind memory registration gate", () => {
  it("blocks memory runtime registration for dual-kind plugins not selected for memory slot", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "dual-plugin",
        name: "Dual Plugin",
        kind: ["memory", "context-engine"],
        memorySlotSidecar: true,
      }),
      register(api) {
        api.registerMemoryRuntime(createStubMemoryRuntime());
      },
    });

    expect(getMemoryRuntime()).toBeUndefined();
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "dual-plugin",
          level: "warn",
          message: expect.stringContaining("memory plugin not selected for memory slot"),
        }),
      ]),
    );
  });

  it("allows memory runtime registration for dual-kind plugins selected for memory slot", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "dual-plugin",
        name: "Dual Plugin",
        kind: ["memory", "context-engine"],
        memorySlotSelected: true,
      }),
      register(api) {
        api.registerMemoryRuntime(createStubMemoryRuntime());
      },
    });

    expect(getMemoryRuntime()).toBeDefined();
    expect(
      registry.registry.diagnostics.filter(
        (d) => d.pluginId === "dual-plugin" && d.level === "warn",
      ),
    ).toHaveLength(0);
  });

  it("allows memory runtime registration for single-kind memory plugins without memorySlotSelected", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "memory-only",
        name: "Memory Only",
        kind: "memory",
      }),
      register(api) {
        api.registerMemoryRuntime(createStubMemoryRuntime());
      },
    });

    expect(getMemoryRuntime()).toBeDefined();
  });

  it("blocks memory runtime registration for sidecar memory plugins that do not own the slot", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "memory-sidecar",
        name: "Memory Sidecar",
        kind: "memory",
        memorySlotSidecar: true,
      }),
      register(api) {
        api.registerMemoryRuntime(createStubMemoryRuntime());
      },
    });

    expect(getMemoryRuntime()).toBeUndefined();
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "memory-sidecar",
          level: "warn",
          message: expect.stringContaining("memory plugin not selected for memory slot"),
        }),
      ]),
    );
  });
});
