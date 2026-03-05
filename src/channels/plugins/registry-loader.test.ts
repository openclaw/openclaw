import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry, type PluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createChannelRegistryLoader } from "./registry-loader.js";

function createRegistryWithChannelIds(ids: string[]): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.channels = ids.map((id) => ({
    pluginId: `plugin-${id}`,
    plugin: { id } as never,
    source: `test-${id}`,
  }));
  return registry;
}

describe("createChannelRegistryLoader", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry(), "test-reset");
  });

  it("caches misses so repeated unknown ids avoid repeated scans", async () => {
    const registry = createRegistryWithChannelIds(["telegram"]);
    const findSpy = vi.spyOn(registry.channels, "find");
    setActivePluginRegistry(registry, "test-miss-cache");

    const loader = createChannelRegistryLoader(() => "resolved");
    await expect(loader("missing")).resolves.toBeUndefined();
    await expect(loader("missing")).resolves.toBeUndefined();

    expect(findSpy).toHaveBeenCalledTimes(1);
  });

  it("caches undefined resolver results to avoid repeat resolution", async () => {
    const registry = createRegistryWithChannelIds(["telegram"]);
    setActivePluginRegistry(registry, "test-undefined-cache");

    let resolveCalls = 0;
    const loader = createChannelRegistryLoader(() => {
      resolveCalls += 1;
      return undefined;
    });

    await expect(loader("telegram")).resolves.toBeUndefined();
    await expect(loader("telegram")).resolves.toBeUndefined();

    expect(resolveCalls).toBe(1);
  });

  it("caches falsy resolved values", async () => {
    const registry = createRegistryWithChannelIds(["telegram"]);
    setActivePluginRegistry(registry, "test-falsy-cache");

    let resolveCalls = 0;
    const loader = createChannelRegistryLoader(() => {
      resolveCalls += 1;
      return "";
    });

    await expect(loader("telegram")).resolves.toBe("");
    await expect(loader("telegram")).resolves.toBe("");

    expect(resolveCalls).toBe(1);
  });

  it("invalidates cached misses when registry instance changes", async () => {
    const firstRegistry = createRegistryWithChannelIds(["telegram"]);
    setActivePluginRegistry(firstRegistry, "test-registry-a");

    const loader = createChannelRegistryLoader((entry) => `${entry.plugin.id}-value`);
    await expect(loader("discord")).resolves.toBeUndefined();

    const secondRegistry = createRegistryWithChannelIds(["discord"]);
    setActivePluginRegistry(secondRegistry, "test-registry-b");

    await expect(loader("discord")).resolves.toBe("discord-value");
  });
});
