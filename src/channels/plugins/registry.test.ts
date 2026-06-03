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

  it("skips unreadable channel plugin ids and snapshots readable metadata", () => {
    const registry = createEmptyPluginRegistry();
    let betaIdReads = 0;
    let betaMetaReads = 0;
    registry.channels = [
      {
        pluginId: "broken",
        plugin: {
          get id() {
            throw new Error("channel id getter exploded");
          },
          meta: { label: "broken" },
        } as never,
        source: "test",
      },
      {
        pluginId: "beta",
        plugin: {
          get id() {
            betaIdReads += 1;
            if (betaIdReads > 1) {
              throw new Error("beta channel id reread");
            }
            return "beta";
          },
          get meta() {
            betaMetaReads += 1;
            if (betaMetaReads > 1) {
              throw new Error("beta channel meta reread");
            }
            return { label: "beta" };
          },
        } as never,
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    const plugins = listChannelPlugins();

    expect(plugins.map((plugin) => plugin.id)).toEqual(["beta"]);
    expect(plugins[0]?.meta.label).toBe("beta");
    expect(betaIdReads).toBe(1);
    expect(betaMetaReads).toBe(1);
    expect(getChannelPlugin("beta")?.id).toBe("beta");
    expect(getLoadedChannelPluginForRead("beta")?.id).toBe("beta");
    expect(betaIdReads).toBe(1);
    expect(betaMetaReads).toBe(1);
    expect(getChannelPlugin("broken")).toBeUndefined();
    expect(getLoadedChannelPluginForRead("broken")).toBeUndefined();
  });

  it("keeps frozen channel plugin descriptors readable", () => {
    const registry = createEmptyPluginRegistry();
    const frozenPlugin = Object.freeze({
      id: "frozen",
      meta: { label: "frozen" },
    });
    registry.channels = [
      {
        pluginId: "frozen",
        plugin: frozenPlugin as never,
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(listChannelPlugins().map((plugin) => plugin.id)).toEqual(["frozen"]);
    expect(getChannelPlugin("frozen")).toBe(frozenPlugin);
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
});
