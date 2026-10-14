import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { PluginInstance } from "./plugin-instance.js";
import { PluginInvocationScope, runPluginCleanupScope } from "./plugin-invocation-scope.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

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
