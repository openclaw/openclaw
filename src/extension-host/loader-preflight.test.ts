import { describe, expect, it, vi } from "vitest";
import { prepareExtensionHostLoaderPreflight } from "./loader-preflight.js";

describe("extension host loader preflight", () => {
  it("returns a cache hit without clearing commands", () => {
    const registry = { plugins: [] } as never;
    const clearPluginCommands = vi.fn();
    const activateRegistry = vi.fn();

    const result = prepareExtensionHostLoaderPreflight({
      options: {
        env: { TEST: "1" },
      },
      createDefaultLogger: vi.fn(() => ({ info() {}, warn() {}, error() {} })) as never,
      clearPluginCommands,
      applyTestDefaults: vi.fn((config) => config) as never,
      normalizeConfig: vi.fn(() => ({ installs: [], entries: {}, slots: {} })) as never,
      buildCacheKey: vi.fn(() => "cache-key") as never,
      getCachedRegistry: vi.fn(() => registry) as never,
      activateRegistry: activateRegistry as never,
    });

    expect(result).toEqual({
      cacheHit: true,
      registry,
    });
    expect(activateRegistry).toHaveBeenCalledWith(registry, "cache-key");
    expect(clearPluginCommands).not.toHaveBeenCalled();
  });

  it("normalizes inputs and clears commands on a cache miss", () => {
    const clearPluginCommands = vi.fn();
    const logger = { info() {}, warn() {}, error() {} };

    const result = prepareExtensionHostLoaderPreflight({
      options: {
        config: { plugins: { enabled: true } },
        workspaceDir: "/workspace",
        env: { TEST: "1" },
        mode: "validate",
      },
      createDefaultLogger: vi.fn(() => logger) as never,
      clearPluginCommands,
      applyTestDefaults: vi.fn((config) => ({
        ...config,
        plugins: { ...config.plugins, allow: ["demo"] },
      })) as never,
      normalizeConfig: vi.fn(() => ({
        enabled: true,
        allow: ["demo"],
        loadPaths: [],
        entries: {},
        slots: {},
      })) as never,
      buildCacheKey: vi.fn(() => "cache-key") as never,
      getCachedRegistry: vi.fn(() => null) as never,
      activateRegistry: vi.fn() as never,
    });

    expect(result).toMatchObject({
      cacheHit: false,
      env: { TEST: "1" },
      logger,
      validateOnly: true,
      cacheKey: "cache-key",
      normalizedConfig: {
        allow: ["demo"],
      },
    });
    expect(clearPluginCommands).toHaveBeenCalledTimes(1);
  });
});
