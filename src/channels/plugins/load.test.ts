import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { loadChannelPlugin } from "./load.js";
import type { ChannelPlugin } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createPlugin(id: string): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({ id }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const emptyRegistry = createTestRegistry([]);

describe("loadChannelPlugin", () => {
  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("returns a plugin from the active registry", async () => {
    const plugin = createPlugin("test-chan");
    const registry = createTestRegistry([{ pluginId: "test-chan", plugin, source: "test" }]);
    setActivePluginRegistry(registry);

    const loaded = await loadChannelPlugin("test-chan");
    expect(loaded).toBe(plugin);
  });

  it("returns undefined for an unknown channel id", async () => {
    const registry = createTestRegistry([
      { pluginId: "known", plugin: createPlugin("known"), source: "test" },
    ]);
    setActivePluginRegistry(registry);

    const loaded = await loadChannelPlugin("unknown-id");
    expect(loaded).toBeUndefined();
  });

  it("returns undefined when the registry is empty", async () => {
    const loaded = await loadChannelPlugin("anything");
    expect(loaded).toBeUndefined();
  });

  it("caches results for the same registry", async () => {
    const plugin = createPlugin("cached");
    const registry = createTestRegistry([{ pluginId: "cached", plugin, source: "test" }]);
    setActivePluginRegistry(registry);

    const first = await loadChannelPlugin("cached");
    const second = await loadChannelPlugin("cached");
    expect(first).toBe(second);
    expect(first).toBe(plugin);
  });

  it("invalidates cache when the registry object changes", async () => {
    const pluginV1 = createPlugin("swap");
    const registryV1 = createTestRegistry([{ pluginId: "swap", plugin: pluginV1, source: "v1" }]);
    setActivePluginRegistry(registryV1);
    expect(await loadChannelPlugin("swap")).toBe(pluginV1);

    const pluginV2 = createPlugin("swap");
    const registryV2 = createTestRegistry([{ pluginId: "swap", plugin: pluginV2, source: "v2" }]);
    setActivePluginRegistry(registryV2);
    expect(await loadChannelPlugin("swap")).toBe(pluginV2);
    expect(await loadChannelPlugin("swap")).not.toBe(pluginV1);
  });

  it("clears stale cache entries after registry swap", async () => {
    const plugin = createPlugin("stale");
    const registryWithPlugin = createTestRegistry([{ pluginId: "stale", plugin, source: "test" }]);
    setActivePluginRegistry(registryWithPlugin);
    expect(await loadChannelPlugin("stale")).toBe(plugin);

    // Swap to a registry that doesn't have the plugin.
    setActivePluginRegistry(emptyRegistry);
    expect(await loadChannelPlugin("stale")).toBeUndefined();
  });
});
