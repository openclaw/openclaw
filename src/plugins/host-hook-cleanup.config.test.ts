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

  it("continues cleanup after unreadable session extension metadata", async () => {
    const registry = createEmptyPluginRegistry();
    const runtimeCleanup = vi.fn();
    const brokenExtension = {
      pluginId: "broken-extension",
      pluginName: "Broken Extension",
      source: "test",
    } as NonNullable<typeof registry.sessionExtensions>[number];
    Object.defineProperty(brokenExtension, "extension", {
      get() {
        throw new Error("session extension getter exploded");
      },
    });
    registry.sessionExtensions = [brokenExtension];
    registry.runtimeLifecycles ??= [];
    registry.runtimeLifecycles.push({
      pluginId: "healthy-runtime",
      pluginName: "Healthy Runtime",
      source: "test",
      lifecycle: {
        id: "healthy-cleanup",
        cleanup: runtimeCleanup,
      },
    });

    const result = await runPluginHostCleanup({
      cfg: {},
      registry,
      reason: "disable",
    });

    expect(runtimeCleanup.mock.calls).toEqual([
      [
        {
          runId: undefined,
          reason: "disable",
          sessionKey: undefined,
        },
      ],
    ]);
    expect(result.cleanupCount).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      pluginId: "broken-extension",
      hookId: "session:unknown",
    });
    expect(result.failures[0]?.error).toBeInstanceOf(Error);
  });
});
