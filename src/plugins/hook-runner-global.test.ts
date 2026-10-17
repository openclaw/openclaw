import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { HookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { markPluginRegistryRetired } from "./registry-lifecycle.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";

const importGlobal = () => import("./hook-runner-global.js");
type Global = typeof import("./hook-runner-global.js");
const runnerOf = (mod: Global): HookRunner => expectDefined(mod.getGlobalHookRunner(), "runner");
function runPolicy(runner: HookRunner, hookName: "before_tool_call" | "before_install") {
  return hookName === "before_tool_call"
    ? runner.runBeforeToolCall({ toolName: "read", params: {} }, { toolName: "read" })
    : runner.runBeforeInstall(
        {
          targetName: "demo",
          targetType: "plugin",
          sourcePath: "/tmp/demo",
          sourcePathKind: "directory",
          origin: "local",
          request: { kind: "plugin-dir", mode: "install" },
          builtinScan: {
            status: "ok",
            scannedFiles: 0,
            critical: 0,
            warn: 0,
            info: 0,
            findings: [],
          },
        },
        { origin: "local", targetType: "plugin", requestKind: "plugin-dir" },
      );
}

async function initialize(registry: Parameters<typeof setActivePluginRegistry>[0]) {
  const mod = await importGlobal();
  setActivePluginRegistry(registry);
  mod.initializeGlobalHookRunner(registry);
  return mod;
}

async function hangingHook(
  hookName: "before_tool_call" | "before_install" | "gateway_stop",
  pluginId: string,
) {
  const release = createDeferredCore();
  const mod = await initialize(
    createMockPluginRegistry([{ hookName, pluginId, handler: () => release.promise }]),
  );
  return { mod, release: () => release.resolve() };
}

afterEach(async () => {
  vi.useRealTimers();
  const mod = await importGlobal();
  mod.resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

describe("hook-runner-global", () => {
  it("clears the shared state across module reloads", async () => {
    resetPluginRuntimeStateForTest();
    const modA = await importGlobal();
    const registry = createMockPluginRegistry([{ hookName: "message_received", handler: vi.fn() }]);
    modA.initializeGlobalHookRunner(registry);
    vi.resetModules();

    const modB = await importGlobal();
    expect(modB.getGlobalPluginRegistry()).toBe(registry);
    expect(runnerOf(modB).hasHooks("message_received")).toBe(true);
    modB.resetGlobalHookRunner();
    expect(modB.getGlobalHookRunner()).toBeNull();
    expect(modB.getGlobalPluginRegistry()).toBeNull();

    vi.resetModules();

    expect((await importGlobal()).getGlobalHookRunner()).toBeNull();
  });

  it("re-admits hook dispatch against the current registry after its prepared generation retires", async () => {
    const retiredHandler = vi.fn(() => {
      throw new PluginInstanceUnavailableError("retired-policy");
    });
    const currentHandler = vi.fn();
    const retiredRegistry = createMockPluginRegistry([
      { hookName: "before_tool_call", pluginId: "retired-policy", handler: retiredHandler },
    ]);
    const currentRegistry = createMockPluginRegistry([
      { hookName: "before_tool_call", pluginId: "current-policy", handler: currentHandler },
    ]);
    const metadataSnapshot = createPluginMetadataSnapshotFixture();
    const mod = await initialize(currentRegistry);
    expect(mod.hasGlobalHooks("before_tool_call", { toolName: "read" })).toBe(true);

    await withPluginRuntimeGenerationScope(
      { metadataSnapshot, pluginRegistry: retiredRegistry },
      async () => {
        markPluginRegistryRetired(retiredRegistry);
        await expect(
          runnerOf(mod).runBeforeToolCall({ toolName: "read", params: {} }, { toolName: "read" }),
        ).resolves.toBeUndefined();
      },
    );

    expect(retiredHandler).not.toHaveBeenCalled();
    expect(currentHandler).toHaveBeenCalledOnce();
  });

  it.each(["before_tool_call", "before_install"] as const)(
    "fails closed when a default-bounded %s handler hangs",
    async (hookName) => {
      vi.useFakeTimers();
      const { mod, release } = await hangingHook(hookName, "hanging-policy");
      const pending = runPolicy(runnerOf(mod), hookName);

      try {
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        const rejection = expect(pending).rejects.toThrow(
          `${hookName} handler from hanging-policy failed: timed out after 15000ms`,
        );
        await vi.advanceTimersByTimeAsync(15_000);
        await rejection;
      } finally {
        release();
        await pending.catch(() => undefined);
      }
    },
  );

  it("bounds gateway_stop handlers and lets shutdown continue", async () => {
    vi.useFakeTimers();
    const { mod, release } = await hangingHook("gateway_stop", "hanging-shutdown");
    const pending = mod.runGlobalGatewayStopSafely({
      event: { reason: "test shutdown" },
      ctx: {},
    });

    try {
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      release();
      await pending;
    }
  });
});
