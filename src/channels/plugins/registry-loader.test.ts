import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginChannelRegistration } from "../../plugins/registry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createChannelRegistryLoader } from "./registry-loader.js";

function channelEntry(id: string, outbound?: unknown): PluginChannelRegistration {
  return {
    pluginId: `plugin-${id}`,
    plugin: { id, outbound } as PluginChannelRegistration["plugin"],
    source: "test",
  };
}

describe("createChannelRegistryLoader", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry(), "test-empty");
  });

  it("caches undefined resolver results", async () => {
    const resolveValue = vi.fn((entry: PluginChannelRegistration) => entry.plugin.outbound);
    const load = createChannelRegistryLoader(resolveValue);

    const registry = createEmptyPluginRegistry();
    registry.channels = [channelEntry("feishu")];
    setActivePluginRegistry(registry, "test-undefined");

    await expect(load("feishu")).resolves.toBeUndefined();
    await expect(load("feishu")).resolves.toBeUndefined();
    expect(resolveValue).toHaveBeenCalledTimes(1);
  });

  it("caches misses for unknown channel ids", async () => {
    const load = createChannelRegistryLoader(() => ({ ok: true }));

    const registry = createEmptyPluginRegistry();
    const channels = [channelEntry("telegram")];
    const findSpy = vi.spyOn(channels, "find");
    registry.channels = channels;
    setActivePluginRegistry(registry, "test-miss");

    await expect(load("missing-channel")).resolves.toBeUndefined();
    await expect(load("missing-channel")).resolves.toBeUndefined();
    expect(findSpy).toHaveBeenCalledTimes(1);
  });

  it("invalidates miss cache when registry changes", async () => {
    const resolveValue = vi.fn((entry: PluginChannelRegistration) => entry.plugin.outbound);
    const load = createChannelRegistryLoader(resolveValue);

    const registryA = createEmptyPluginRegistry();
    registryA.channels = [channelEntry("slack")];
    setActivePluginRegistry(registryA, "test-a");

    await expect(load("discord")).resolves.toBeUndefined();

    const outboundAdapter = { send: vi.fn() };
    const registryB = createEmptyPluginRegistry();
    registryB.channels = [channelEntry("discord", outboundAdapter)];
    setActivePluginRegistry(registryB, "test-b");

    await expect(load("discord")).resolves.toBe(outboundAdapter);
    expect(resolveValue).toHaveBeenCalledTimes(1);
  });
});
