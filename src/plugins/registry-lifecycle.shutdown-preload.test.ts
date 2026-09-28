import { afterEach, expect, it, vi } from "vitest";
import type { disposePluginRegistryInstances } from "./runtime.js";

const fixture = vi.hoisted(() => ({
  rotated: false,
  dispose: vi.fn<typeof disposePluginRegistryInstances>(async () => ({
    cleanupCount: 0,
    failures: [],
  })),
}));

vi.mock("./runtime.js", () => ({
  get disposePluginRegistryInstances() {
    if (fixture.rotated) {
      throw Object.assign(new Error("installed registry runtime chunk was removed"), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    }
    return fixture.dispose;
  },
}));
vi.mock("./host-hook-cleanup.js", () => ({
  createPluginHostRegistryRetirement: () => async () => ({ cleanupCount: 0, failures: [] }),
}));
vi.mock("./memory-runtime.js", () => ({}));

afterEach(() => {
  fixture.rotated = false;
  fixture.dispose.mockClear();
});

it.each([false, true])(
  "retires cached registry resources after installation rotation (copied SDK graph: %s)",
  async (copied) => {
    const { prepareActivePluginRegistryShutdown } =
      await vi.importActual<typeof import("./runtime.js")>("./runtime.js");
    await prepareActivePluginRegistryShutdown();
    if (copied) {
      vi.resetModules();
    }
    const [
      { createPluginCache, retirePluginCache },
      { getPluginLoaderCacheState },
      { PluginInstance },
      { createEmptyPluginRegistry },
      { createPluginRecord },
    ] = await Promise.all([
      import("./plugin-cache.js"),
      import("./registry-lifecycle.js"),
      import("./plugin-instance.js"),
      import("./registry-empty.js"),
      import("./loader-records.js"),
    ]);
    const cache = createPluginCache();
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({
      id: "cached-shutdown",
      source: "fixture",
      origin: "config",
      enabled: true,
      configSchema: false,
    });
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry });
    const cleanup = vi.fn();
    instance.lifecycle.onDispose(cleanup);
    getPluginLoaderCacheState(cache).set("cached-shutdown", registry);
    fixture.rotated = true;
    await expect(retirePluginCache(cache)).resolves.toMatchObject({ failures: [] });
    expect(instance.acceptingCalls).toBe(false);
    expect(getPluginLoaderCacheState(cache).get("cached-shutdown")).toBeUndefined();
    await retirePluginCache(cache);
    expect(cleanup).toHaveBeenCalledOnce();
  },
);
