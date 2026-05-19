import { describe, expect, it, vi } from "vitest";
import { afterEach } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import {
  makeIsolatedEnv,
  resetPluginAutoEnableTestState,
} from "./plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "./types.openclaw.js";

vi.mock("../channels/plugins/configured-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/plugins/configured-state.js")>();
  return {
    ...actual,
    hasBundledChannelConfiguredState: () => false,
    isRuntimeChannelConnected: () => false,
  };
});

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>();
  return {
    ...actual,
  };
});

afterEach(() => {
  resetPluginAutoEnableTestState();
});

describe("applyPluginAutoEnable caching", () => {
  it("returns the same result for the same config and env references", () => {
    const config: OpenClawConfig = {};
    const env = makeIsolatedEnv();
    const result1 = applyPluginAutoEnable({ config, env });
    const result2 = applyPluginAutoEnable({ config, env });
    expect(result1).toBe(result2);
  });

  it("recomputes when config reference changes", () => {
    const env = makeIsolatedEnv();
    const config1: OpenClawConfig = {};
    const config2: OpenClawConfig = {};
    const result1 = applyPluginAutoEnable({ config: config1, env });
    const result2 = applyPluginAutoEnable({ config: config2, env });
    expect(result1).not.toBe(result2);
    expect(result1).toEqual(result2);
  });

  it("works without config or env (no cache, no crash)", () => {
    const result1 = applyPluginAutoEnable({});
    const result2 = applyPluginAutoEnable({});
    expect(result1).toEqual(result2);
    // Without config/env, no caching — different object references
    expect(result1).not.toBe(result2);
  });

  it("recomputes when manifestRegistry reference changes", () => {
    const config: OpenClawConfig = {};
    const env = makeIsolatedEnv();
    const registry1: PluginManifestRegistry = { plugins: [], diagnostics: [] };
    const registry2: PluginManifestRegistry = { plugins: [], diagnostics: [] };
    const result1 = applyPluginAutoEnable({ config, env, manifestRegistry: registry1 });
    const result2 = applyPluginAutoEnable({ config, env, manifestRegistry: registry2 });
    // Different registry references should produce separate cache entries
    expect(result1).not.toBe(result2);
    expect(result1).toEqual(result2);
  });

  it("caches separately for calls with and without manifestRegistry", () => {
    const config: OpenClawConfig = {};
    const env = makeIsolatedEnv();
    const registry: PluginManifestRegistry = { plugins: [], diagnostics: [] };
    const withoutRegistry = applyPluginAutoEnable({ config, env });
    const withRegistry = applyPluginAutoEnable({ config, env, manifestRegistry: registry });
    // Should be separate cache entries
    expect(withoutRegistry).not.toBe(withRegistry);
    // But same config/env/registry should hit cache
    const withRegistryAgain = applyPluginAutoEnable({ config, env, manifestRegistry: registry });
    expect(withRegistry).toBe(withRegistryAgain);
  });

  it("cached calls are faster than uncached calls", () => {
    const env = makeIsolatedEnv();
    // First call with config1 — uncached
    const config1: OpenClawConfig = {};
    const uncachedStart = performance.now();
    applyPluginAutoEnable({ config: config1, env });
    const uncachedTime = performance.now() - uncachedStart;

    // 7 cached calls with same config1
    const cachedStart = performance.now();
    for (let i = 0; i < 7; i++) {
      applyPluginAutoEnable({ config: config1, env });
    }
    const cachedTime = performance.now() - cachedStart;

    // Cached batch of 7 should be faster than a single uncached call
    expect(cachedTime).toBeLessThan(uncachedTime);
  });
});
