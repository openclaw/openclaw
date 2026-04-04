import { afterEach, describe, expect, it } from "vitest";
import { __testing, clearPluginLoaderCache, resolveRuntimePluginRegistry } from "./loader.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import {
  getMemoryEmbeddingProvider,
  registerMemoryEmbeddingProvider,
} from "./memory-embedding-providers.js";
import {
  buildMemoryPromptSection,
  getMemoryRuntime,
  registerMemoryFlushPlanResolver,
  registerMemoryPromptSection,
  registerMemoryRuntime,
  resolveMemoryFlushPlan,
} from "./memory-state.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

describe("getCompatibleActivePluginRegistry", () => {
  it("requires cache key match when activate is omitted (default activating)", () => {
    const registry = createEmptyPluginRegistry();
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo"],
          load: { paths: ["/tmp/demo.js"] },
        },
      },
      workspaceDir: "/tmp/workspace-a",
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    };
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey);

    expect(__testing.getCompatibleActivePluginRegistry(loadOptions)).toBe(registry);
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        workspaceDir: "/tmp/workspace-b",
      }),
    ).toBeUndefined();
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        onlyPluginIds: ["demo"],
      }),
    ).toBeUndefined();
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        runtimeOptions: undefined,
      }),
    ).toBeUndefined();
  });

  it("reuses active registry for explicit non-activating loads regardless of cache key", () => {
    const registry = createEmptyPluginRegistry();
    const baseOptions = {
      config: {
        plugins: {
          allow: ["demo"],
          load: { paths: ["/tmp/demo.js"] },
        },
      },
      workspaceDir: "/tmp/workspace-a",
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    };
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(baseOptions);
    setActivePluginRegistry(registry, cacheKey);

    // activate:false (snapshot / metadata-only) always reuses the active
    // registry — it is a superset of any narrower snapshot request.
    expect(__testing.getCompatibleActivePluginRegistry({ ...baseOptions, activate: false })).toBe(
      registry,
    );
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...baseOptions,
        activate: false,
        workspaceDir: "/tmp/workspace-b",
      }),
    ).toBe(registry);
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...baseOptions,
        activate: false,
        onlyPluginIds: ["demo"],
      }),
    ).toBe(registry);
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...baseOptions,
        activate: false,
        runtimeOptions: undefined,
      }),
    ).toBe(registry);
  });

  it("requires cache key match for explicitly activating loads", () => {
    const registry = createEmptyPluginRegistry();
    const loadOptions = {
      activate: true as const,
      config: {
        plugins: {
          allow: ["demo"],
          load: { paths: ["/tmp/demo.js"] },
        },
      },
      workspaceDir: "/tmp/workspace-a",
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    };
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey);

    expect(__testing.getCompatibleActivePluginRegistry(loadOptions)).toBe(registry);
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        workspaceDir: "/tmp/workspace-b",
      }),
    ).toBeUndefined();
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        onlyPluginIds: ["demo"],
      }),
    ).toBeUndefined();
  });

  it("does not embed activation secrets in the loader cache key", () => {
    const { cacheKey } = __testing.resolvePluginLoadCacheContext({
      config: {
        plugins: {
          allow: ["telegram"],
        },
      },
      activationSourceConfig: {
        plugins: {
          allow: ["telegram"],
        },
        channels: {
          telegram: {
            enabled: true,
            botToken: "secret-token",
          },
        },
      },
      autoEnabledReasons: {
        telegram: ["telegram configured"],
      },
    });

    expect(cacheKey).not.toContain("secret-token");
    expect(cacheKey).not.toContain("botToken");
    expect(cacheKey).not.toContain("telegram configured");
  });

  it("falls back to the current active runtime when no compatibility-shaping inputs are supplied", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry, "startup-registry");

    expect(__testing.getCompatibleActivePluginRegistry()).toBe(registry);
  });

  it("does not reuse the active registry when core gateway method names differ in activating loads", () => {
    const registry = createEmptyPluginRegistry();
    const loadOptions = {
      activate: true as const,
      config: {
        plugins: {
          allow: ["demo"],
          load: { paths: ["/tmp/demo.js"] },
        },
      },
      workspaceDir: "/tmp/workspace-a",
      coreGatewayHandlers: {
        "sessions.get": () => undefined,
      },
    };
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey);

    expect(__testing.getCompatibleActivePluginRegistry(loadOptions)).toBe(registry);
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        coreGatewayHandlers: {
          "sessions.get": () => undefined,
          "sessions.list": () => undefined,
        },
      }),
    ).toBeUndefined();
  });

  it("reuses the active registry for explicit non-activating loads even when gateway handlers differ", () => {
    const registry = createEmptyPluginRegistry();
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo"],
          load: { paths: ["/tmp/demo.js"] },
        },
      },
      workspaceDir: "/tmp/workspace-a",
      coreGatewayHandlers: {
        "sessions.get": () => undefined,
      },
    };
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey);

    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        activate: false,
        coreGatewayHandlers: {
          "sessions.get": () => undefined,
          "sessions.list": () => undefined,
        },
      }),
    ).toBe(registry);
  });
});

describe("resolveRuntimePluginRegistry", () => {
  it("reuses the compatible active registry before attempting a fresh load", () => {
    const registry = createEmptyPluginRegistry();
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo"],
        },
      },
      workspaceDir: "/tmp/workspace-a",
    };
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey);

    expect(resolveRuntimePluginRegistry(loadOptions)).toBe(registry);
  });

  it("falls back to the current active runtime when no explicit load context is provided", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry, "startup-registry");

    expect(resolveRuntimePluginRegistry()).toBe(registry);
  });
});

describe("clearPluginLoaderCache", () => {
  it("resets registered memory plugin registries", () => {
    registerMemoryEmbeddingProvider({
      id: "stale",
      create: async () => ({ provider: null }),
    });
    registerMemoryPromptSection(() => ["stale memory section"]);
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 2,
      reserveTokensFloor: 3,
      prompt: "stale",
      systemPrompt: "stale",
      relativePath: "memory/stale.md",
    }));
    registerMemoryRuntime({
      async getMemorySearchManager() {
        return { manager: null };
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" as const };
      },
    });
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([
      "stale memory section",
    ]);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/stale.md");
    expect(getMemoryRuntime()).toBeDefined();
    expect(getMemoryEmbeddingProvider("stale")).toBeDefined();

    clearPluginLoaderCache();

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([]);
    expect(resolveMemoryFlushPlan({})).toBeNull();
    expect(getMemoryRuntime()).toBeUndefined();
    expect(getMemoryEmbeddingProvider("stale")).toBeUndefined();
  });
});
