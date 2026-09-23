// Covers host hook cleanup behavior controlled by plugin config.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPluginHostCleanup } from "./host-hook-cleanup.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

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

  it.each([
    { label: "host-only cleanup", params: { reason: "reset" } },
    {
      label: "restart without promoted session slots",
      params: { reason: "restart", pluginId: "cleanup-plugin" },
    },
    {
      label: "explicit empty store targets",
      params: { reason: "disable", pluginId: "cleanup-plugin", sessionStoreTargets: [] },
    },
  ] as const)("does not load ambient config for $label", async ({ params }) => {
    const registry = createEmptyPluginRegistry();
    const cleanup = vi.fn();
    registry.runtimeLifecycles.push({
      pluginId: "cleanup-plugin",
      pluginName: "Cleanup Plugin",
      source: "test",
      lifecycle: { id: "runtime-cleanup", cleanup },
    });
    mocks.getRuntimeConfig.mockImplementation(() => {
      throw new Error("ambient config must not be opened for this cleanup");
    });

    const result = await runPluginHostCleanup({ registry, ...params });

    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(result).toEqual({ cleanupCount: 1, failures: [] });
  });

  it("records session store config failures while continuing runtime cleanup", async () => {
    const registry = createEmptyPluginRegistry();
    const cleanup = vi.fn();
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
});
