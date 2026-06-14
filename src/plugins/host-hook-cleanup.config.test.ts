// Covers host hook cleanup behavior controlled by plugin config.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPluginHostCleanup } from "./host-hook-cleanup.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRuntimeLifecycleRegistryRegistration } from "./registry-types.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

describe("plugin host cleanup config fallback", () => {
  afterEach(() => {
    mocks.getRuntimeConfig.mockReset();
  });

  it("records session store config failures while continuing runtime cleanup", async () => {
    const registry = createEmptyPluginRegistry();
    const cleanup = vi.fn();
    registry.runtimeLifecycles ??= [];
    registry.runtimeLifecycles.push({
      pluginId: "cleanup-plugin",
      pluginName: "Cleanup Plugin",
      source: "test",
      lifecycle: {
        id: "runtime-cleanup",
        cleanup,
      },
    });
    const configError = new Error("invalid config");
    mocks.getRuntimeConfig.mockImplementation(() => {
      throw configError;
    });

    const result = await runPluginHostCleanup({
      registry,
      pluginId: "cleanup-plugin",
      reason: "disable",
    });

    expect(cleanup.mock.calls).toEqual([
      [
        {
          runId: undefined,
          reason: "disable",
          sessionKey: undefined,
        },
      ],
    ]);
    expect(result.cleanupCount).toBe(1);
    expect(result.failures).toEqual([
      {
        error: configError,
        pluginId: "cleanup-plugin",
        hookId: "session-store",
      },
    ]);
  });

  it("records unreadable runtime lifecycle metadata while continuing cleanup", async () => {
    const registry = createEmptyPluginRegistry();
    const cleanup = vi.fn();
    const staleLifecycle = {
      pluginId: "cleanup-plugin",
      pluginName: "Cleanup Plugin",
      source: "test",
    } as PluginRuntimeLifecycleRegistryRegistration;
    Object.defineProperty(staleLifecycle, "lifecycle", {
      get() {
        throw new Error("plugin runtime lifecycle metadata getter exploded");
      },
    });
    registry.runtimeLifecycles = [
      staleLifecycle,
      {
        pluginId: "cleanup-plugin",
        pluginName: "Cleanup Plugin",
        source: "test",
        lifecycle: {
          id: "runtime-cleanup",
          cleanup,
        },
      },
    ];

    const result = await runPluginHostCleanup({
      registry,
      pluginId: "cleanup-plugin",
      reason: "disable",
      sessionStorePaths: [],
    });

    expect(cleanup).toHaveBeenCalledOnce();
    expect(result.cleanupCount).toBe(1);
    expect(result.failures).toEqual([
      {
        error: expect.objectContaining({
          message: "plugin runtime lifecycle metadata getter exploded",
        }),
        pluginId: "cleanup-plugin",
        hookId: "runtime:<unreadable>",
      },
    ]);
  });

  it("ignores unreadable runtime lifecycle metadata outside targeted cleanup", async () => {
    const registry = createEmptyPluginRegistry();
    const cleanup = vi.fn();
    const staleLifecycle = {
      pluginId: "other-plugin",
      pluginName: "Other Plugin",
      source: "test",
    } as PluginRuntimeLifecycleRegistryRegistration;
    Object.defineProperty(staleLifecycle, "lifecycle", {
      get() {
        throw new Error("other plugin runtime lifecycle metadata getter exploded");
      },
    });
    registry.runtimeLifecycles = [
      staleLifecycle,
      {
        pluginId: "cleanup-plugin",
        pluginName: "Cleanup Plugin",
        source: "test",
        lifecycle: {
          id: "runtime-cleanup",
          cleanup,
        },
      },
    ];

    const result = await runPluginHostCleanup({
      registry,
      pluginId: "cleanup-plugin",
      reason: "disable",
      sessionStorePaths: [],
    });

    expect(cleanup).toHaveBeenCalledOnce();
    expect(result).toEqual({ cleanupCount: 1, failures: [] });
  });
});
