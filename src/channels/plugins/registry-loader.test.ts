import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createChannelRegistryLoader } from "./registry-loader.js";

describe("createChannelRegistryLoader", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("resolves value from the active registry", async () => {
    const registry = createEmptyPluginRegistry();
    const outbound = { sendText: async () => ({}) };
    registry.channels = [
      { plugin: { id: "discord", outbound } } as never,
    ];
    setActivePluginRegistry(registry);

    const loader = createChannelRegistryLoader((entry) => entry.plugin.outbound);
    const result = await loader("discord");
    expect(result).toBe(outbound);
  });

  it("returns undefined when channel is not in any registry", async () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);

    const loader = createChannelRegistryLoader((entry) => entry.plugin.outbound);
    const result = await loader("discord");
    expect(result).toBeUndefined();
  });

  it("falls back to pinned channel-surface registry when active registry lacks the channel", async () => {
    // Simulate gateway startup: plugins loaded with Discord, channel surface pinned.
    const startup = createEmptyPluginRegistry();
    const outbound = { sendText: async () => ({}) };
    startup.channels = [
      { plugin: { id: "discord", outbound } } as never,
    ];
    setActivePluginRegistry(startup);
    pinActivePluginChannelRegistry(startup);

    // Simulate a non-primary plugin reload (config-schema read, provider
    // snapshot) that replaces the active registry with a minimal one that
    // does NOT include channel plugins.
    const replacement = createEmptyPluginRegistry();
    setActivePluginRegistry(replacement);

    const loader = createChannelRegistryLoader((entry) => entry.plugin.outbound);
    const result = await loader("discord");
    expect(result).toBe(outbound);
  });

  it("does not fall back when channel surface is the same as active registry", async () => {
    // Both registries are the same object — no channel in it.
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);

    const loader = createChannelRegistryLoader((entry) => entry.plugin.outbound);
    const result = await loader("discord");
    expect(result).toBeUndefined();
  });

  it("invalidates cache when pinned channel registry is released", async () => {
    // 1. Pinned startup has discord; active replacement does not.
    const startup = createEmptyPluginRegistry();
    const outbound = { sendText: async () => ({}) };
    startup.channels = [{ plugin: { id: "discord", outbound } } as never];
    setActivePluginRegistry(startup);
    pinActivePluginChannelRegistry(startup);

    const replacement = createEmptyPluginRegistry();
    setActivePluginRegistry(replacement);

    const loader = createChannelRegistryLoader((entry) => entry.plugin.outbound);
    // Resolved from pinned surface and cached.
    expect(await loader("discord")).toBe(outbound);

    // 2. Release pin — channel surface falls back to active (no discord).
    releasePinnedPluginChannelRegistry(startup);

    // Cache should be invalidated by the channel-version bump even though
    // the active registry pointer did not change.
    expect(await loader("discord")).toBeUndefined();
  });

  it("clears cache when active registry changes", async () => {
    const first = createEmptyPluginRegistry();
    const outbound1 = { sendText: async () => ({ v: 1 }) };
    first.channels = [{ plugin: { id: "discord", outbound: outbound1 } } as never];
    setActivePluginRegistry(first);

    const loader = createChannelRegistryLoader((entry) => entry.plugin.outbound);
    expect(await loader("discord")).toBe(outbound1);

    // Swap registry — cache should invalidate.
    const second = createEmptyPluginRegistry();
    const outbound2 = { sendText: async () => ({ v: 2 }) };
    second.channels = [{ plugin: { id: "discord", outbound: outbound2 } } as never];
    setActivePluginRegistry(second);

    expect(await loader("discord")).toBe(outbound2);
  });
});
