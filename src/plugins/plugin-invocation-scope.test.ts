import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { PluginInstance } from "./plugin-instance.js";
import { createOwnedTestInstance } from "./plugin-instance.test-support.js";
import { PluginInvocationScope, runPluginCleanupScope } from "./plugin-invocation-scope.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

it("creates only final teardown views while fencing each retained owner's callbacks", async () => {
  const instance = createOwnedTestInstance("retained-siblings");
  const registry = instance.owner!.registry!;
  const first = new PluginInvocationScope(registry, [instance], { retained: true });
  const second = new PluginInvocationScope(registry, [instance], { retained: true });
  const callback = instance.wrap(() => {
    expect(getPluginRuntimeGatewayRequestScope()?.pluginId).toBe(instance.pluginId);
    expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
    return "owner";
  });
  const firstCallback = first.wrap(callback);
  const secondCallback = second.wrap(callback);
  expect(first.wrap(callback)).toBe(firstCallback);
  expect(secondCallback).not.toBe(firstCallback);
  expect(firstCallback()).toBe("owner");
  expect(secondCallback()).toBe("owner");
  const views = vi.spyOn(instance, "createRegistryView");
  const cleanup = first.beginCleanup();
  try {
    // One final view, with no throwaway ordinary view before teardown admission.
    expect(views).toHaveBeenCalledTimes(1);
    instance.quiesce();
    expect(() => firstCallback()).toThrow(/closed/);
    expect(secondCallback()).toBe("owner");
    expect(cleanup.scope.run(callback)).toBe("owner");
    const cleanupCallback = cleanup.scope.wrap(callback);
    expect(cleanupCallback()).toBe("owner");
    await cleanup.release();
    expect(() => cleanupCallback()).toThrow(/closed/);
    expect(() => firstCallback()).toThrow(/closed/);
    expect(secondCallback()).toBe("owner");
  } finally {
    views.mockRestore();
    second.release();
    await cleanup.release();
  }
});

it("finishes plugin and module disposal after its caller scope closes", async () => {
  const instance = new PluginInstance("closed-caller-cleanup");
  const scope = new PluginInvocationScope(createEmptyPluginRegistry(), [instance]);
  const completed: string[] = [];
  instance.lifecycle.onDispose(() => {
    completed.push("plugin");
  });
  instance.onModuleDispose(() => {
    completed.push("module");
  });
  const result = await scope.run(() => {
    scope.release();
    return instance.dispose();
  });
  expect(result.errors).toEqual([]);
  expect(completed).toEqual(["plugin", "module"]);
});

it.each(["idle", "active"])(
  "bounds %s cross-plugin teardown authority to its host cleanup",
  async (mode) => {
    const first = new PluginInstance("first-cleanup");
    const second = new PluginInstance("second-cleanup");
    const unrelated = new PluginInstance("unrelated-cleanup");
    const called = vi.fn();
    const callback = second.wrap(called);
    const forbidden = unrelated.wrap(called);
    const service = first.wrap({ stop: async () => callback() });
    for (const instance of [first, second, unrelated]) {
      instance.quiesce();
    }
    const delayed = createDeferredCore();
    let late: Promise<void> | undefined;
    await runPluginCleanupScope([service, callback], async () => {
      await service.stop();
      expect(() => forbidden()).toThrow(PluginInstanceUnavailableError);
      const resume = async () => {
        await delayed.promise;
        callback();
      };
      late = mode === "active" ? second.wrap(resume)() : resume();
    });
    const refused = expect(late).rejects.toThrow("Plugin cleanup scope is closed");
    delayed.resolve();
    await refused;
    expect(called).toHaveBeenCalledOnce();
    for (const instance of [first, second, unrelated]) {
      await instance.dispose();
    }
  },
);
