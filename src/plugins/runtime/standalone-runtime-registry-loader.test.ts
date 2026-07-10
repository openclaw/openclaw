// Standalone runtime registry loader tests cover registry loading outside gateway startup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFinalToolInputPolicies } from "../final-tool-input-policy.js";
import { getGlobalHookRunnerRegistry } from "../hook-runner-global-state.js";
import {
  getGlobalPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../hook-runner-global.js";
import { clearPluginLoaderCache, testing } from "../loader.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import type { PluginRegistry } from "../registry-types.js";
import {
  getActivePluginChannelRegistry,
  getActivePluginRegistry,
  pinActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../runtime.js";

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

const { ensureStandaloneRuntimePluginRegistryLoaded } =
  await import("./standalone-runtime-registry-loader.js");

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
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

describe("ensureStandaloneRuntimePluginRegistryLoaded", () => {
  it("reuses a compatible gateway startup registry for gateway-bindable dispatch load options", () => {
    const activeRegistry = createRegistryWithPlugin("telegram");
    activeRegistry.coreGatewayMethodNames = ["sessions.get", "sessions.list"];
    const config = { plugins: { allow: ["telegram"] } };
    const startupLoadOptions = {
      config,
      activationSourceConfig: config,
      autoEnabledReasons: {},
      workspaceDir: "/tmp/ws",
      onlyPluginIds: ["telegram"],
      coreGatewayMethodNames: ["sessions.get", "sessions.list"],
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
      preferBuiltPluginArtifacts: true,
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(startupLoadOptions);
    setActivePluginRegistry(activeRegistry, cacheKey, "gateway-bindable", "/tmp/ws");

    const result = ensureStandaloneRuntimePluginRegistryLoaded({
      loadOptions: {
        config,
        onlyPluginIds: ["telegram"],
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
        workspaceDir: "/tmp/ws",
      },
    });

    expect(result).toBe(activeRegistry);
    expect(loaderMocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("loads a fresh registry when dispatch config is not startup-compatible", () => {
    const activeRegistry = createRegistryWithPlugin("telegram");
    activeRegistry.coreGatewayMethodNames = ["sessions.get", "sessions.list"];
    const config = { plugins: { allow: ["telegram"] } };
    const startupLoadOptions = {
      config,
      activationSourceConfig: config,
      autoEnabledReasons: {},
      workspaceDir: "/tmp/ws",
      onlyPluginIds: ["telegram"],
      coreGatewayMethodNames: ["sessions.get", "sessions.list"],
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
      preferBuiltPluginArtifacts: true,
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(startupLoadOptions);
    setActivePluginRegistry(activeRegistry, cacheKey, "gateway-bindable", "/tmp/ws");
    const loadedRegistry = createRegistryWithPlugin("telegram");
    loaderMocks.loadOpenClawPlugins.mockReturnValue(loadedRegistry);

    const result = ensureStandaloneRuntimePluginRegistryLoaded({
      loadOptions: {
        config: {
          plugins: {
            allow: ["telegram"],
            load: { paths: ["/tmp/changed.js"] },
          },
        },
        onlyPluginIds: ["telegram"],
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
        workspaceDir: "/tmp/ws",
      },
    });

    expect(result).toBe(loadedRegistry);
    expect(loaderMocks.loadOpenClawPlugins).toHaveBeenCalledOnce();
  });

  it("cold-loads required policy owners with an explicitly scoped plugin", () => {
    const loadedRegistry = createRegistryWithPlugin("target-plugin");
    loaderMocks.loadOpenClawPlugins.mockReturnValue(loadedRegistry);
    const config = {
      plugins: {
        entries: {
          "runtime-policy": { requiredFinalToolInputPolicies: ["pdp"] },
          unrelated: { enabled: true },
        },
      },
    };
    const activationSourceConfig = {
      plugins: {
        entries: {
          "activation-policy": { requiredFinalToolInputPolicies: ["guard"] },
        },
      },
    };

    const result = ensureStandaloneRuntimePluginRegistryLoaded({
      loadOptions: {
        config,
        activationSourceConfig,
        onlyPluginIds: ["target-plugin"],
        workspaceDir: "/tmp/ws",
      },
    });

    expect(result).toBe(loadedRegistry);
    expect(loaderMocks.loadOpenClawPlugins).toHaveBeenCalledWith({
      config,
      activationSourceConfig,
      onlyPluginIds: ["activation-policy", "runtime-policy", "target-plugin"],
      workspaceDir: "/tmp/ws",
    });
  });

  it("reuses a registry cached under the widened policy-owner scope", () => {
    const registry = createRegistryWithPlugin("target-plugin");
    registry.plugins.push({ id: "enterprise-policy", status: "loaded" } as never);
    const config = {
      plugins: {
        entries: {
          "enterprise-policy": { requiredFinalToolInputPolicies: ["pdp"] },
        },
      },
    };
    const widenedLoadOptions = {
      config,
      onlyPluginIds: ["enterprise-policy", "target-plugin"],
      workspaceDir: "/tmp/ws",
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(widenedLoadOptions);
    setActivePluginRegistry(registry, cacheKey, "default", "/tmp/ws");

    const result = ensureStandaloneRuntimePluginRegistryLoaded({
      loadOptions: {
        config,
        onlyPluginIds: ["target-plugin"],
        workspaceDir: "/tmp/ws",
      },
    });

    expect(result).toBe(registry);
    expect(loaderMocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("keeps an unscoped cold load unscoped when policy owners are required", () => {
    loaderMocks.loadOpenClawPlugins.mockReturnValue(createRegistryWithPlugin("enterprise-policy"));
    const config = {
      plugins: {
        entries: {
          "enterprise-policy": { requiredFinalToolInputPolicies: ["pdp"] },
        },
      },
    };

    ensureStandaloneRuntimePluginRegistryLoaded({
      loadOptions: { config, workspaceDir: "/tmp/ws" },
    });

    expect(loaderMocks.loadOpenClawPlugins).toHaveBeenCalledWith({
      config,
      workspaceDir: "/tmp/ws",
    });
  });
});

describe("ensureStandaloneRuntimePluginRegistryLoaded tool-discovery installs", () => {
  it("does not replace active or pinned channel registries during tool discovery", () => {
    const activeRegistry = createRegistryWithPlugin("provider-only");
    setActivePluginRegistry(activeRegistry, "active-key", "default", "/tmp/ws");
    const channelRegistry = createRegistryWithPlugin("channel-plugin");
    pinActivePluginChannelRegistry(channelRegistry);
    const toolRegistry = createRegistryWithPlugin("tool-plugin");
    loaderMocks.loadOpenClawPlugins.mockReturnValue(toolRegistry);

    ensureStandaloneRuntimePluginRegistryLoaded({
      surface: "channel",
      forceLoad: true,
      loadOptions: {
        onlyPluginIds: ["tool-plugin"],
        activate: false,
        toolDiscovery: true,
        workspaceDir: "/tmp/ws",
      },
    });

    expect(getActivePluginRegistry()).toBe(activeRegistry);
    expect(getActivePluginChannelRegistry()).toBe(channelRegistry);
  });

  it("does not replace the active registry for a tool-discovery active load", () => {
    const activeRegistry = createRegistryWithPlugin("provider-only");
    setActivePluginRegistry(activeRegistry, "active-key", "default", "/tmp/ws");
    const toolRegistry = createRegistryWithPlugin("tool-plugin");
    loaderMocks.loadOpenClawPlugins.mockReturnValue(toolRegistry);

    const result = ensureStandaloneRuntimePluginRegistryLoaded({
      surface: "active",
      forceLoad: true,
      loadOptions: {
        onlyPluginIds: ["tool-plugin"],
        activate: false,
        toolDiscovery: true,
        workspaceDir: "/tmp/ws",
      },
    });

    expect(result).toBe(toolRegistry);
    expect(getActivePluginRegistry()).toBe(activeRegistry);
  });

  it("does not promote a migration-provider snapshot into the active registry", () => {
    const activeRegistry = createRegistryWithPlugin("provider-only");
    setActivePluginRegistry(activeRegistry, "active-key", "default", "/tmp/ws");
    const migrationRegistry = createRegistryWithPlugin("migration-plugin");
    loaderMocks.loadOpenClawPlugins.mockReturnValue(migrationRegistry);

    ensureStandaloneRuntimePluginRegistryLoaded({
      surface: "active",
      forceLoad: true,
      loadOptions: {
        onlyPluginIds: ["migration-plugin"],
        activate: false,
        workspaceDir: "/tmp/ws",
      },
    });

    expect(getActivePluginRegistry()).toBe(activeRegistry);
  });

  it("widens a forced request-local snapshot without promoting it", () => {
    const activeRegistry = createRegistryWithPlugin("provider-only");
    setActivePluginRegistry(activeRegistry, "active-key", "default", "/tmp/ws");
    const snapshotRegistry = createRegistryWithPlugin("migration-plugin");
    loaderMocks.loadOpenClawPlugins.mockReturnValue(snapshotRegistry);
    const config = {
      plugins: {
        entries: {
          "enterprise-policy": { requiredFinalToolInputPolicies: ["pdp"] },
        },
      },
    };

    const result = ensureStandaloneRuntimePluginRegistryLoaded({
      surface: "active",
      forceLoad: true,
      loadOptions: {
        config,
        onlyPluginIds: [],
        activate: false,
        workspaceDir: "/tmp/ws",
      },
    });

    expect(result).toBe(snapshotRegistry);
    expect(loaderMocks.loadOpenClawPlugins).toHaveBeenCalledWith({
      config,
      onlyPluginIds: ["enterprise-policy"],
      activate: false,
      workspaceDir: "/tmp/ws",
      cache: false,
    });
    expect(getActivePluginRegistry()).toBe(activeRegistry);
  });

  it("preserves the active sealed policy boundary across migration snapshots", async () => {
    const activeRegistry = createRegistryWithPlugin("enterprise-policy");
    activeRegistry.finalToolInputPolicies.push({
      pluginId: "enterprise-policy",
      pluginName: "Enterprise Policy",
      source: "test",
      policy: {
        id: "pdp",
        description: "deny test calls",
        evaluate: () => ({ outcome: "deny", reasonCode: "test.denied" }),
      },
    });
    setActivePluginRegistry(activeRegistry, "active-policy", "default", "/tmp/ws");
    initializeGlobalHookRunner(activeRegistry);
    loaderMocks.loadOpenClawPlugins.mockReturnValue(createRegistryWithPlugin("migration-plugin"));

    ensureStandaloneRuntimePluginRegistryLoaded({
      surface: "active",
      forceLoad: true,
      loadOptions: {
        onlyPluginIds: ["migration-plugin"],
        activate: false,
        workspaceDir: "/tmp/ws",
      },
    });

    expect(getActivePluginRegistry()).toBe(activeRegistry);
    expect(getGlobalPluginRegistry()).toBe(activeRegistry);
    expect(Object.isFrozen(activeRegistry.finalToolInputPolicies)).toBe(true);
    const decision = await runFinalToolInputPolicies(
      { toolName: "exec", params: { command: "echo test" } },
      { toolName: "exec" },
      { registry: getGlobalHookRunnerRegistry() },
    );
    expect(decision).toMatchObject({
      block: true,
      pluginId: "enterprise-policy",
      policyId: "pdp",
      reasonCode: "test.denied",
    });
  });

  it("keeps runtime surfaces empty for a cold tool-discovery load", () => {
    // Establish the cold-start precondition deterministically (no active registry).
    resetPluginRuntimeStateForTest();
    const toolRegistry = createRegistryWithPlugin("tool-plugin");
    loaderMocks.loadOpenClawPlugins.mockReturnValue(toolRegistry);

    const result = ensureStandaloneRuntimePluginRegistryLoaded({
      surface: "channel",
      forceLoad: true,
      loadOptions: {
        onlyPluginIds: ["tool-plugin"],
        activate: false,
        toolDiscovery: true,
        workspaceDir: "/tmp/ws",
      },
    });

    expect(result).toBe(toolRegistry);
    expect(getActivePluginRegistry()).toBeNull();
  });
});
