import { execFile } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { PluginHostCleanupResult } from "./host-hook-cleanup.types.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { disposePluginRegistryInstances, waitForPluginRegistryRetirement } from "./runtime.js";
import { createPluginRecord } from "./status.test-helpers.js";

it.each([
  { mode: "registry", name: "releases successors while a retired registry remains reachable" },
  { mode: "cache", name: "releases callback captures while a retired cache remains reachable" },
  { mode: "formatter", name: "finishes cache retirement when a custom stack formatter throws" },
  {
    mode: "instance",
    name: "releases captured source lookups while a retired instance remains reachable",
  },
])(
  "$name",
  async ({ mode }) => {
    await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        fileURLToPath(new URL("./runtime.retention.test-support.ts", import.meta.url)),
        mode,
      ],
      { timeout: 20_000 },
    );
  },
  25_000,
);

it("keeps retirement pending after self acknowledgement and preserves its final cleanup failure", async () => {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "retention-timing" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  const consumer = instance.retainConsumer();
  const acknowledged = createDeferredCore<PluginHostCleanupResult>();
  const cleanupEntered = createDeferredCore();
  const releaseCleanup = createDeferredCore();
  const failure = new Error("retention cleanup failure");
  let cleanups = 0;
  instance.lifecycle.onDispose(async () => {
    cleanups += 1;
    cleanupEntered.resolve();
    await releaseCleanup.promise;
    throw failure;
  });
  const call = instance.run(async () => {
    acknowledged.resolve(await disposePluginRegistryInstances(registry, undefined, { cfg: {} }));
  });
  void call.catch(acknowledged.reject);
  let settled = false;
  let retirement: ReturnType<typeof waitForPluginRegistryRetirement> | undefined;
  try {
    expect(await acknowledged.promise).toEqual({ cleanupCount: 0, failures: [] });
    expect(await waitForPluginRegistryRetirement(registry, { deferConsumers: true })).toEqual({
      cleanupCount: 0,
      failures: [],
      deferredPluginIds: [record.id],
    });
    retirement = waitForPluginRegistryRetirement(registry).then((result) => {
      settled = true;
      return result;
    });
    consumer.release();
    await cleanupEntered.promise;
    await setImmediate();
    expect(settled).toBe(false);
    releaseCleanup.resolve();
    const result = await retirement;
    await call;
    expect(result).toEqual({
      cleanupCount: 0,
      failures: [{ pluginId: record.id, hookId: "instance", error: failure }],
    });
    const repeated = await waitForPluginRegistryRetirement(registry);
    expect(repeated).toEqual(result);
    expect(repeated.failures[0]?.error).toBe(failure);
    expect(cleanups).toBe(1);
  } finally {
    consumer.release();
    releaseCleanup.resolve();
    await Promise.allSettled([call, retirement, instance.dispose()]);
  }
});
