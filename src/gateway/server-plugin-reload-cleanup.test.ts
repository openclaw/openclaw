import { assert, describe, expect, it, vi } from "vitest";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginInstance, pluginInvocationContext } from "../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createPluginReloadCleanup,
  PluginReloadDeferredError,
} from "./server-plugin-reload-cleanup.js";

function fixture(priorCleanup?: Parameters<typeof createPluginReloadCleanup>[0]["priorCleanup"]) {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({ id: "selected", source: "/synthetic/selected.ts" });
  builder.registry.plugins.push(record);
  builder.createApi(record, { config: {} });
  const instance = getPluginInstance(record);
  assert(instance);
  const cleanup = createPluginReloadCleanup({
    previousRegistry: builder.registry,
    changedPluginIds: new Set(["selected"]),
    port: 0,
    pluginWorkspaceDir: undefined,
    getCron: () => {
      throw new Error("no cron operation expected");
    },
    abortSignal: new AbortController().signal,
    log: createSubsystemLogger("test/plugin-reload"),
    recordCleanup: vi.fn(),
    recordWarning: vi.fn(),
    retainRetirement: vi.fn(),
    priorCleanup,
  });
  return { instance, cleanup };
}

describe("automatic plugin reload pre-fence admission", () => {
  it("returns exact busy instances without reserving or quiescing them", () => {
    const { instance, cleanup } = fixture();
    const release = instance.retainWork();
    const reserve = vi.spyOn(instance, "reserveReplacement");
    try {
      expect(() => cleanup.assertAutomaticReloadIdle(new Set(["selected"]))).toThrow(
        PluginReloadDeferredError,
      );
      try {
        cleanup.assertAutomaticReloadIdle(new Set(["selected"]));
      } catch (error) {
        expect(error).toMatchObject({ instances: [instance] });
      }
      expect(reserve).not.toHaveBeenCalled();
      expect(instance.acceptingCalls).toBe(true);
      expect(instance.run(() => "still serving")).toBe("still serving");
    } finally {
      release();
    }
    expect(() => cleanup.assertAutomaticReloadIdle(new Set(["selected"]))).not.toThrow();
  });

  it("defers ordinary calls and rechecks work admitted after initial planning", async () => {
    const { instance, cleanup } = fixture();
    cleanup.assertAutomaticReloadIdle(new Set(["selected"]));
    const gate = createDeferredCore();
    const call = instance.run(() => gate.promise);
    try {
      expect(() => cleanup.assertAutomaticReloadIdle(new Set(["selected"]))).toThrow(
        PluginReloadDeferredError,
      );
      expect(instance.replacementPending).toBe(false);
    } finally {
      gate.resolve();
      await call;
    }
  });

  it("carries prior cleanup settlement even when selected instances are idle", () => {
    const gate = createDeferredCore();
    const { instance, cleanup } = fixture(() => ({ settled: gate.promise, instances: [] }));
    try {
      cleanup.assertAutomaticReloadIdle(new Set(["selected"]));
      throw new Error("expected deferred cleanup");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginReloadDeferredError);
      expect(error).toMatchObject({ instances: [instance], priorCleanup: gate.promise });
    } finally {
      gate.resolve();
    }
  });

  it("refuses only exact retained instances, not another instance with the same plugin id", () => {
    const { instance, cleanup } = fixture();
    const foreign = fixture().instance;
    const ids = new Set(["selected"]);
    pluginInvocationContext.run({ lookup: () => undefined, retainedInstances: [foreign] }, () =>
      cleanup.assertResourceHandoff(ids)(),
    );
    expect(instance.replacementPending).toBe(false);
    pluginInvocationContext.run({ lookup: () => undefined, retainedInstances: [instance] }, () =>
      expect(() => cleanup.assertResourceHandoff(ids)).toThrow("own active turn"),
    );
    expect(instance.replacementPending).toBe(false);
  });
});
