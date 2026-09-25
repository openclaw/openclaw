import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../src/shared/deferred.js";

const hooks = vi.hoisted(() => ({ afterEach: [] as Array<() => Promise<void>> }));
vi.mock("vitest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vitest")>()),
  beforeAll: () => {},
  afterAll: () => {},
  afterEach: (cleanup: () => Promise<void>) => hooks.afterEach.push(cleanup),
}));

it.each([false, true])(
  "joins retired plugin caches in the registered runtime reset (cleanup fails: %s)",
  async (fails) => {
    vi.resetModules();
    hooks.afterEach.length = 0;
    await import("./setup-openclaw-runtime.js");
    const cleanup = hooks.afterEach.at(-1);
    if (!cleanup) {
      throw new Error("Runtime setup did not register its cleanup hook");
    }
    const { getProcessPluginCache, retainPluginCacheInstance, waitForPluginCacheRetirement } =
      await import("../src/plugins/plugin-cache.js");
    const { PluginInstance } = await import("../src/plugins/plugin-instance.js");
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    const failure = new Error("synthetic plugin retirement failure");
    const instance = new PluginInstance("runtime-reset-fixture");
    instance.lifecycle.onDispose(async () => {
      entered.resolve();
      await finish.promise;
      if (fails) {
        throw failure;
      }
    });
    retainPluginCacheInstance(instance, getProcessPluginCache());
    let settled = false;
    const result = cleanup().then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await entered.promise;
      expect(settled).toBe(false);
      finish.resolve();
      if (fails) {
        const error = await result;
        expect(error).toBeInstanceOf(AggregateError);
        if (!(error instanceof AggregateError)) {
          throw new Error("Runtime cleanup did not report the plugin retirement failure");
        }
        expect(error.errors).toEqual([
          { pluginId: "runtime-reset-fixture", hookId: "instance", error: failure },
        ]);
      } else {
        await expect(result).resolves.toBeUndefined();
      }
      await expect(waitForPluginCacheRetirement()).resolves.toEqual({
        cleanupCount: 0,
        failures: [],
      });
    } finally {
      finish.resolve();
      await result;
      await waitForPluginCacheRetirement();
    }
  },
);
