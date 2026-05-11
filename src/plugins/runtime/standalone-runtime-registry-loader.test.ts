import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPluginLoaderCache } from "../loader.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import type { PluginRegistry } from "../registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../runtime.js";

const loaderMocks = vi.hoisted(() => ({
  loadOpenClawPlugins: vi.fn<typeof import("../loader.js").loadOpenClawPlugins>(),
}));

vi.mock("../loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../loader.js")>();
  return {
    ...actual,
    loadOpenClawPlugins: (...args: Parameters<typeof loaderMocks.loadOpenClawPlugins>) =>
      loaderMocks.loadOpenClawPlugins(...args),
  };
});

const { ensureStandaloneRuntimePluginRegistryLoaded } = await import(
  "./standalone-runtime-registry-loader.js"
);

function createRegistryWithPlugin(pluginId: string): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push({
    id: pluginId,
    status: "loaded",
  } as never);
  return registry;
}

beforeEach(() => {
  loaderMocks.loadOpenClawPlugins.mockReset();
});

afterEach(() => {
  clearPluginLoaderCache();
  resetPluginRuntimeStateForTest();
});

describe("ensureStandaloneRuntimePluginRegistryLoaded", () => {
  it("reuses the active registry when load-option cache keys diverge but workspace + plugin ids match", () => {
    const activeRegistry = createRegistryWithPlugin("demo");
    setActivePluginRegistry(activeRegistry, "boot-time-cache-key", "default", "/tmp/ws");

    // Dispatch-path callers (`ensureRuntimePluginsLoaded`) build a 3-field
    // load-options object while gateway-startup builds a 9+ field one. The
    // load-options hashes differ even though both name "/tmp/ws" + "demo".
    const dispatchLoadOptions = {
      config: { plugins: { allow: ["demo"] } },
      onlyPluginIds: ["demo"],
      workspaceDir: "/tmp/ws",
    };

    const result = ensureStandaloneRuntimePluginRegistryLoaded({
      loadOptions: dispatchLoadOptions,
    });

    expect(result).toBe(activeRegistry);
    expect(loaderMocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("loads a fresh registry when the active registry is workspace-incompatible", () => {
    const activeRegistry = createRegistryWithPlugin("demo");
    setActivePluginRegistry(activeRegistry, "boot-time-cache-key", "default", "/tmp/ws-A");

    const loadedRegistry = createRegistryWithPlugin("demo");
    loaderMocks.loadOpenClawPlugins.mockReturnValue(loadedRegistry);

    const result = ensureStandaloneRuntimePluginRegistryLoaded({
      loadOptions: {
        config: { plugins: { allow: ["demo"] } },
        onlyPluginIds: ["demo"],
        workspaceDir: "/tmp/ws-B",
      },
    });

    expect(result).toBe(loadedRegistry);
    expect(result).not.toBe(activeRegistry);
    expect(loaderMocks.loadOpenClawPlugins).toHaveBeenCalledOnce();
  });

  it("loads a fresh registry when the active registry is missing required plugins", () => {
    const activeRegistry = createRegistryWithPlugin("memory-core");
    setActivePluginRegistry(activeRegistry, "boot-time-cache-key", "default", "/tmp/ws");

    const loadedRegistry = createRegistryWithPlugin("demo");
    loaderMocks.loadOpenClawPlugins.mockReturnValue(loadedRegistry);

    const result = ensureStandaloneRuntimePluginRegistryLoaded({
      loadOptions: {
        config: { plugins: { allow: ["demo"] } },
        onlyPluginIds: ["demo"],
        workspaceDir: "/tmp/ws",
      },
    });

    expect(result).toBe(loadedRegistry);
    expect(result).not.toBe(activeRegistry);
    expect(loaderMocks.loadOpenClawPlugins).toHaveBeenCalledOnce();
  });
});
