// Covers host hook cleanup behavior controlled by plugin config.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPluginHostCleanup } from "./host-hook-cleanup.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

const mocks = vi.hoisted(() => ({
  readRuntimeConfig: vi.fn(),
}));

vi.mock("../config/io.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.runtime.js")>()),
  captureRuntimeConfigAsyncReader: () =>
    Object.assign(mocks.readRuntimeConfig, { assertCurrent() {} }),
}));

describe("plugin host cleanup config fallback", () => {
  afterEach(() => {
    mocks.readRuntimeConfig.mockReset();
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
    mocks.readRuntimeConfig.mockRejectedValue(configError);

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
