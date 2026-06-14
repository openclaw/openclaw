// Registry tests cover channel plugin registry installation, lookup, and reset behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { getLoadedChannelPluginForRead } from "./registry-loaded-read.js";
import { getChannelPlugin, listChannelPlugins } from "./registry.js";

vi.mock("./bundled.js", () => ({
  getBundledChannelPlugin: (id: string) =>
    id === "fallback"
      ? {
          id: "fallback",
          meta: { label: "fallback" },
        }
      : undefined,
}));

function withMalformedChannels(registry: PluginRegistry): PluginRegistry {
  const malformed = { ...registry } as PluginRegistry;
  (malformed as { channels?: unknown }).channels = undefined;
  return malformed;
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("listChannelPlugins", () => {
  it("returns an empty list when runtime registry has no channels field", () => {
    const malformedRegistry = withMalformedChannels(createEmptyPluginRegistry());
    setActivePluginRegistry(malformedRegistry);

    expect(listChannelPlugins()).toStrictEqual([]);
  });

  it("falls back to bundled channel plugins for direct lookups before registry bootstrap", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());

    expect(getChannelPlugin("fallback")?.meta.label).toBe("fallback");
  });

  it("rebuilds channel lookups when the active registry object changes without a version bump", () => {
    const first = createEmptyPluginRegistry();
    first.channels = [
      {
        pluginId: "alpha",
        plugin: {
          id: "alpha",
          meta: { label: "alpha" },
        } as never,
        source: "test",
      },
    ];
    setActivePluginRegistry(first);

    expect(getChannelPlugin("alpha")?.meta.label).toBe("alpha");
    expect(getChannelPlugin("beta")).toBeUndefined();

    const second = createEmptyPluginRegistry();
    second.channels = [
      {
        pluginId: "beta",
        plugin: {
          id: "beta",
          meta: { label: "beta" },
        } as never,
        source: "test",
      },
    ];
    setActivePluginRegistry(second);

    expect(getChannelPlugin("alpha")).toBeUndefined();
    expect(getChannelPlugin("beta")?.meta.label).toBe("beta");
    expect(listChannelPlugins().map((plugin) => plugin.id)).toEqual(["beta"]);
  });

  it("keeps loaded channel plugin identities stable across registry reads", () => {
    const registry = createEmptyPluginRegistry();
    const plugin = {
      id: "alpha",
      meta: { label: "alpha" },
    };
    registry.channels = [
      {
        pluginId: "alpha",
        plugin: plugin as never,
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    const first = listChannelPlugins()[0];
    expect(first).toBe(plugin);
    expect(listChannelPlugins()[0]).toBe(first);
    expect(getChannelPlugin("alpha")).toBe(first);
  });

  it("skips loaded channel plugins with unreadable ids", () => {
    const registry = createEmptyPluginRegistry();
    const brokenPlugin = Object.defineProperty(
      {
        meta: { label: "broken" },
      },
      "id",
      {
        get() {
          throw new Error("channel id getter exploded");
        },
      },
    );
    registry.channels = [
      {
        pluginId: "broken",
        plugin: brokenPlugin as never,
        source: "test",
      },
      {
        pluginId: "healthy",
        plugin: {
          id: "healthy",
          meta: { label: "healthy" },
        } as never,
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(listChannelPlugins().map((plugin) => plugin.id)).toEqual(["healthy"]);
  });

  it("skips unreadable loaded channel ids in the direct read path", () => {
    const registry = createEmptyPluginRegistry();
    const brokenPlugin = Object.defineProperty(
      {
        meta: { label: "broken" },
      },
      "id",
      {
        get() {
          throw new Error("direct read channel id getter exploded");
        },
      },
    );
    registry.channels = [
      {
        pluginId: "broken",
        plugin: brokenPlugin as never,
        source: "test",
      },
      {
        pluginId: "healthy",
        plugin: {
          id: "healthy",
          meta: { label: "healthy" },
        } as never,
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(getLoadedChannelPluginForRead("healthy")?.id).toBe("healthy");
    expect(getLoadedChannelPluginForRead("broken")).toBeUndefined();
  });

  it("falls back when loaded channel order metadata is unreadable", () => {
    const registry = createEmptyPluginRegistry();
    const brokenOrderMeta = Object.defineProperty(
      {
        label: "broken-order",
      },
      "order",
      {
        get() {
          throw new Error("channel order getter exploded");
        },
      },
    );
    registry.channels = [
      {
        pluginId: "broken-order",
        plugin: {
          id: "broken-order",
          meta: brokenOrderMeta,
        } as never,
        source: "test",
      },
      {
        pluginId: "healthy",
        plugin: {
          id: "healthy",
          meta: { label: "healthy", order: 1 },
        } as never,
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(listChannelPlugins().map((plugin) => plugin.id)).toEqual(["healthy", "broken-order"]);
    expect(getChannelPlugin("broken-order")?.meta.label).toBe("broken-order");
  });
});
