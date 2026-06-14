// Covers active runtime plugin registry state and reset behavior.
import { afterEach, describe, expect, it } from "vitest";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { testing, clearPluginLoaderCache } from "./loader.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

afterEach(() => {
  clearPluginLoaderCache();
  resetPluginRuntimeStateForTest();
});

function createRegistryWithPlugin(pluginId: string): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push({
    id: pluginId,
    status: "loaded",
  } as never);
  return registry;
}

describe("getLoadedRuntimePluginRegistry", () => {
  it("treats an explicit empty plugin scope as empty", () => {
    setActivePluginRegistry(createRegistryWithPlugin("stale"), "stale", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: [],
      }),
    ).toBeUndefined();

    const emptyRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(emptyRegistry, "empty", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: [],
      }),
    ).toBe(emptyRegistry);
  });

  it("does not treat disabled plugin records as an empty plugin scope", () => {
    const disabledRegistry = createEmptyPluginRegistry();
    disabledRegistry.plugins.push({
      id: "disabled",
      status: "disabled",
    } as never);
    setActivePluginRegistry(disabledRegistry, "disabled", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: [],
      }),
    ).toBeUndefined();
  });

  it("does not treat diagnostics as loaded plugin records", () => {
    const failedRegistry = createEmptyPluginRegistry();
    failedRegistry.plugins.push({
      id: "failed",
      status: "error",
    } as never);
    failedRegistry.diagnostics.push({
      level: "error",
      pluginId: "failed",
      message: "failed to load",
    } as never);
    setActivePluginRegistry(failedRegistry, "failed", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["failed"],
      }),
    ).toBeUndefined();
  });

  it("does not treat setup-only registrations as loaded plugin records", () => {
    const setupRegistry = createEmptyPluginRegistry();
    setupRegistry.plugins.push({
      id: "setup-only",
      status: "disabled",
    } as never);
    setupRegistry.channelSetups.push({
      pluginId: "setup-only",
    } as never);
    setActivePluginRegistry(setupRegistry, "setup-only", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["setup-only"],
      }),
    ).toBeUndefined();
  });

  it("keeps healthy runtime plugins after unreadable plugin record metadata", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({
      get id() {
        throw new Error("plugin id getter exploded");
      },
      status: "loaded",
    } as never);
    registry.plugins.push({
      id: "healthy",
      status: "loaded",
    } as never);
    setActivePluginRegistry(registry, "healthy", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["healthy"],
      }),
    ).toBe(registry);
  });

  it("does not treat unreadable runtime metadata as an empty plugin scope", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({
      get id() {
        throw new Error("plugin id getter exploded");
      },
      status: "loaded",
    } as never);
    setActivePluginRegistry(registry, "broken", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: [],
      }),
    ).toBeUndefined();
  });

  it("does not treat unreadable plugin status as loaded through registrations", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({
      id: "broken",
      get status() {
        throw new Error("plugin status getter exploded");
      },
    } as never);
    registry.tools.push({
      pluginId: "broken",
    } as never);
    setActivePluginRegistry(registry, "broken", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["broken"],
      }),
    ).toBeUndefined();
  });

  it("keeps healthy runtime plugins after unreadable registration owner metadata", () => {
    const registry = createRegistryWithPlugin("healthy");
    registry.tools.push({
      get pluginId() {
        throw new Error("plugin registration owner getter exploded");
      },
    } as never);
    registry.tools.push({
      pluginId: "healthy",
    } as never);
    setActivePluginRegistry(registry, "healthy", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["healthy"],
      }),
    ).toBe(registry);
  });

  it("does not treat unreadable registration owner metadata as an empty plugin scope", () => {
    const registry = createEmptyPluginRegistry();
    registry.tools.push({
      get pluginId() {
        throw new Error("plugin registration owner getter exploded");
      },
    } as never);
    setActivePluginRegistry(registry, "broken", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: [],
      }),
    ).toBeUndefined();
  });

  it("does not reuse workspace-agnostic registries for workspace-specific requests", () => {
    setActivePluginRegistry(createRegistryWithPlugin("demo"), "demo");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["demo"],
      }),
    ).toBeUndefined();
  });

  it("validates full loader cache compatibility when load options are provided", () => {
    const registry = createRegistryWithPlugin("demo");
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo"],
        },
      },
      onlyPluginIds: ["demo"],
      workspaceDir: "/tmp/ws",
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey, "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        loadOptions,
      }),
    ).toBe(registry);

    expect(
      getLoadedRuntimePluginRegistry({
        loadOptions: {
          ...loadOptions,
          config: {
            plugins: {
              allow: ["other"],
            },
          },
        },
      }),
    ).toBeUndefined();
  });
});
