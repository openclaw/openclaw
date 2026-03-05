import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createChannelRegistryLoader } from "./registry-loader.js";
import type { ChannelId } from "./types.js";

const emptyRegistry = createTestRegistry([]);

describe("createChannelRegistryLoader", () => {
  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("caches missing channel ids to avoid repeated registry scans", async () => {
    const registry = createTestRegistry([
      {
        pluginId: "msteams",
        plugin: { id: "msteams" },
        source: "test",
      },
    ]);
    const findSpy = vi.spyOn(registry.channels, "find");
    setActivePluginRegistry(registry);

    const load = createChannelRegistryLoader(() => "ok");

    expect(await load("telegram" as ChannelId)).toBeUndefined();
    expect(await load("telegram" as ChannelId)).toBeUndefined();
    expect(findSpy).toHaveBeenCalledTimes(1);
  });

  it("caches undefined resolver results", async () => {
    const registry = createTestRegistry([
      {
        pluginId: "slack",
        plugin: { id: "slack" },
        source: "test",
      },
    ]);
    setActivePluginRegistry(registry);

    const resolveValue = vi.fn(() => undefined);
    const load = createChannelRegistryLoader(resolveValue);

    expect(await load("slack" as ChannelId)).toBeUndefined();
    expect(await load("slack" as ChannelId)).toBeUndefined();
    expect(resolveValue).toHaveBeenCalledTimes(1);
  });

  it("caches falsy resolved values", async () => {
    const registry = createTestRegistry([
      {
        pluginId: "slack",
        plugin: { id: "slack" },
        source: "test",
      },
    ]);
    setActivePluginRegistry(registry);

    const resolveValue = vi.fn(() => 0);
    const load = createChannelRegistryLoader<number>(resolveValue);

    expect(await load("slack" as ChannelId)).toBe(0);
    expect(await load("slack" as ChannelId)).toBe(0);
    expect(resolveValue).toHaveBeenCalledTimes(1);
  });
});
