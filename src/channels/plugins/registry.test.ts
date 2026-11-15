import { afterEach, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { normalizeAnyChannelId } from "../registry-normalize.js";
import {
  getChannelPlugin,
  getLoadedChannelPlugin,
  listChannelPlugins,
  resolveChannelPluginRegistration,
} from "./registry.js";

// mock-isolation: This fixture owns fallback channels without loading real bundled plugins.
vi.mock("./bundled.js", () => ({
  getBundledChannelPlugin: (id: string) =>
    id === "fallback" ? { id, meta: { label: id } } : undefined,
}));

afterEach(resetPluginRuntimeStateForTest);

function channelEntry(id: string, label = id, pluginId = id) {
  return { pluginId, plugin: createChannelTestPluginBase({ id, label }), source: "test" };
}

function registryWith(...channels: ReturnType<typeof createEmptyPluginRegistry>["channels"]) {
  const registry = createEmptyPluginRegistry();
  registry.channels = channels;
  return registry;
}

it("keeps the scoped channel implementation and its registration provenance together", () => {
  const root = channelEntry("fallback", "Root", "root");
  const scoped = channelEntry("fallback", "Scoped", "scoped");
  const resolveChannelRuntime = vi.fn();
  setActivePluginRegistry(registryWith({ ...root, origin: "bundled" }));
  const registry = registryWith({
    ...scoped,
    origin: "config",
    resolveChannelRuntime,
  });

  withPluginRuntimeRegistryScope(registry, () => {
    expect(resolveChannelPluginRegistration("fallback")).toEqual({
      plugin: scoped.plugin,
      origin: "config",
      resolveChannelRuntime,
    });
    expect(getChannelPlugin("fallback")).toBe(scoped.plugin);
  });
  expect(getChannelPlugin("fallback")).toBe(root.plugin);
});

it("preserves unrelated root and bundled addressability inside an empty CLI handle", () => {
  const root = channelEntry("root-only");
  setActivePluginRegistry(registryWith(root));

  withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () => {
    expect(getChannelPlugin("root-only")).toBe(root.plugin);
    expect(resolveChannelPluginRegistration("fallback")?.origin).toBe("bundled");
  });
});

it("keeps the first channel implementation and provenance when channel ids collide", () => {
  const first = {
    ...channelEntry("duplicate", "first", "first-plugin"),
    origin: "config" as const,
  };
  const second = {
    ...channelEntry("duplicate", "second", "second-plugin"),
    origin: "bundled" as const,
  };
  setActivePluginRegistry(registryWith(first, second));

  expect(listChannelPlugins()).toEqual([first.plugin]);
  expect(getLoadedChannelPlugin("duplicate")).toBe(first.plugin);
  expect(normalizeAnyChannelId("DUPLICATE")).toBe("duplicate");
  expect(getLoadedChannelPlugin("DUPLICATE")).toBeUndefined();
  expect(resolveChannelPluginRegistration("duplicate")).toEqual({
    plugin: first.plugin,
    origin: "config",
  });
});

it("rebuilds channel lookups when the active registry object changes without a version bump", () => {
  setActivePluginRegistry(registryWith(channelEntry("alpha")));

  expect(getChannelPlugin("alpha")?.meta.label).toBe("alpha");
  expect(getChannelPlugin("beta")).toBeUndefined();

  setActivePluginRegistry(registryWith(channelEntry("beta")));

  expect(getChannelPlugin("alpha")).toBeUndefined();
  expect(getChannelPlugin("beta")?.meta.label).toBe("beta");
  expect(listChannelPlugins().map((plugin) => plugin.id)).toEqual(["beta"]);
});

it("builds the loaded channel view once per registry version", () => {
  const registry = createEmptyPluginRegistry();
  let buildCount = 0;
  registry.channels = new Proxy([channelEntry("zeta"), channelEntry("alpha")], {
    get(target, property, receiver) {
      if (property === Symbol.iterator) {
        buildCount += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  setActivePluginRegistry(registry);

  expect(normalizeAnyChannelId("alpha")).toBe("alpha");
  expect(getChannelPlugin("alpha")?.meta.label).toBe("alpha");
  expect(resolveChannelPluginRegistration("zeta")?.plugin.meta.label).toBe("zeta");
  expect(listChannelPlugins().map((plugin) => plugin.id)).toEqual(["alpha", "zeta"]);
  expect(buildCount).toBe(1);

  setActivePluginRegistry(registry);

  expect(normalizeAnyChannelId("zeta")).toBe("zeta");
  expect(getChannelPlugin("alpha")?.meta.label).toBe("alpha");
  expect(listChannelPlugins().map((plugin) => plugin.id)).toEqual(["alpha", "zeta"]);
  expect(buildCount).toBe(2);
});
