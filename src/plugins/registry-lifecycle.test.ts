import { AsyncResource } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { loadPluginRegistryHandle } from "./loader.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import { createPluginCache, retirePluginCache } from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  capturePluginLifecycleAuthority as captureAuthority,
  capturePluginRegistryLifecycleEpoch as captureEpoch,
  capturePluginRegistryLifecycleSignal as captureSignal,
  getPluginLoaderCacheState,
  isPluginRecordActive as isRecordActive,
  isPluginRegistryPreparing,
  isPluginRegistryLifecycleEpochActive as isEpochActive,
  markPluginRegistryActive as markActive,
  listPluginCacheRetiringRegistries,
  markPluginRegistryRetired as markRetired,
  revokePluginRecord,
  withPluginRegistryPreparationScope,
} from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import * as runtime from "./runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

function captureActivation(registry: PluginRegistry) {
  const epoch = captureEpoch(registry)!;
  expect(epoch).toBeDefined();
  const signal = captureSignal(registry, epoch)!;
  expect(signal).toBeDefined();
  return { epoch, signal };
}

function registryWithRecord(registry = createEmptyPluginRegistry()) {
  const record = createPluginRecord({ id: "owner" });
  registry.plugins.push(record);
  return { registry, record };
}

function callableRegistry(value: string) {
  const { registry, record } = registryWithRecord();
  const instance = new PluginInstance(record.id, { record, registry });
  return { registry, record, call: instance.wrap(() => value) };
}

afterEach(() => runtime.resetPluginRuntimeStateForTest());
afterEach(resetPluginLoaderTestStateForTest);

it.each(["return", "throw", "resolve", "reject"] as const)(
  "releases preparation authority and its registry after %s",
  async (outcome) => {
    class RetainedService {
      id = "preparation-retention";
      start() {}
    }
    const failure = new Error("preparation fixture failure");
    const asynchronous = outcome === "resolve" || outcome === "reject";
    const rejects = outcome === "throw" || outcome === "reject";
    async function prepare() {
      const registry = createEmptyPluginRegistry();
      const service = new RetainedService();
      const { id } = service;
      registry.services.push({ id, pluginId: id, source: id, origin: "config", service });
      let resource: AsyncResource | undefined;
      const { promise: pending, resolve: release } = createDeferredCore();
      let rejected = false;
      try {
        const result = withPluginRegistryPreparationScope(registry, () => {
          expect(isPluginRegistryPreparing(registry)).toBe(true);
          resource = new AsyncResource("plugin-preparation-retention");
          const finish = () => {
            expect(isPluginRegistryPreparing(registry)).toBe(true);
            if (rejects) {
              throw failure;
            }
            return "prepared";
          };
          return asynchronous ? pending.then(finish) : finish();
        });
        expect(isPluginRegistryPreparing(registry)).toBe(false);
        if (asynchronous) {
          expect(resource!.runInAsyncScope(() => isPluginRegistryPreparing(registry))).toBe(true);
        }
        release();
        expect(await result).toBe("prepared");
      } catch (error) {
        expect(error).toBe(failure);
        rejected = true;
      } finally {
        release();
      }
      expect(rejected).toBe(rejects);
      expect(resource!.runInAsyncScope(() => isPluginRegistryPreparing(registry))).toBe(false);
      return resource!;
    }
    const resource = await prepare();
    try {
      await setImmediate();
      expect(queryObjects(RetainedService)).toBe(0);
    } finally {
      resource.emitDestroy();
    }
  },
);

it.each([
  [true, "retire"],
  [true, "activate"],
  [false, "retire"],
  [false, "activate"],
] as const)("revokes authority before listeners (scoped=%s, transition=%s)", (scoped, action) => {
  const { registry, record } = registryWithRecord(
    scoped ? loadPluginRegistryHandle({ onlyPluginIds: [] }) : undefined,
  );
  if (scoped) {
    expect(captureSignal(registry, undefined)).toBeUndefined();
  } else {
    markActive(registry);
  }
  const epoch = captureEpoch(registry);
  const { signal, authority } = withPluginRuntimeRegistryScope(registry, () => {
    const scopedRuntime = getPluginRuntimeGatewayRequestScope()?.pluginRegistry === registry;
    const options = { scopedRuntime };
    return {
      signal: captureSignal(registry, epoch, options)!,
      authority: captureAuthority(registry, undefined, scoped ? options : undefined)!,
    };
  });
  expect([signal?.aborted, authority()]).toEqual([false, true]);
  expect(isRecordActive(registry, record)).toBe(!scoped);
  if (scoped) {
    expect(captureEpoch(registry)).toBeUndefined();
    expect(captureSignal(registry, epoch)).toBeUndefined();
  }
  expect(captureSignal(registry, epoch, { scopedRuntime: true })).toBe(signal);
  const observations: unknown[] = [];
  signal.addEventListener("abort", () => {
    const nextEpoch = captureEpoch(registry);
    // Capture event-time registry, record, authority, old signal, and successor state.
    observations.push([
      epoch ? isEpochActive(registry, epoch) : false,
      isRecordActive(registry, record),
      authority(),
      captureSignal(registry, epoch),
      nextEpoch ? isEpochActive(registry, nextEpoch) : false,
      nextEpoch ? captureSignal(registry, nextEpoch)?.aborted : undefined,
    ]);
  });

  (action === "retire" ? markRetired : markActive)(registry);

  expect(signal.aborted).toBe(true);
  const active = action === "activate";
  expect(observations).toEqual([
    [false, active, false, undefined, active, active ? false : undefined],
  ]);
  expect(captureSignal(registry, epoch, { scopedRuntime: true })).toBeUndefined();
  markActive(registry);
  const next = captureActivation(registry);
  expect(next.epoch).not.toBe(epoch);
  expect([next.signal.aborted, signal.aborted, authority()]).toEqual([false, true, false]);
  expect(observations).toHaveLength(1);
});

it("keeps epoch identity opaque and rejects missing or mismatched activation signals", () => {
  const registry = createEmptyPluginRegistry();
  const other = createEmptyPluginRegistry();
  expect(captureSignal(registry, {})).toBeUndefined();
  expect(captureAuthority(registry)).toBeUndefined();
  const scopedAuthority = captureAuthority(registry, undefined, { scopedRuntime: true });
  expect(scopedAuthority?.()).toBe(true);
  markActive(registry);
  const { epoch, signal } = captureActivation(registry);
  expect(Object.isFrozen(epoch)).toBe(true);
  for (const property of ["abort", "controller", "signal"]) {
    expect(epoch).not.toHaveProperty(property);
  }
  expect(captureEpoch(registry)).toBe(epoch);
  expect(captureSignal(registry, epoch)).toBe(signal);
  expect(captureSignal(other, epoch)).toBeUndefined();
  expect(captureSignal(registry, { ...epoch })).toBeUndefined();
  expect(scopedAuthority?.()).toBe(false);
});

it("keeps exact-instance callbacks live across activation but never revives a retired replacement", async () => {
  const { registry: original, record: oldRecord, call: oldCall } = callableRegistry("old instance");
  const { registry: replacement, call: newCall } = callableRegistry("new instance");
  try {
    runtime.setActivePluginRegistry(original);
    const registryAuthority = captureAuthority(original)!;
    const recordAuthority = captureAuthority(original, oldRecord)!;
    runtime.setActivePluginRegistry(original);
    expect(registryAuthority()).toBe(false);
    expect(recordAuthority()).toBe(true);
    expect(oldCall()).toBe("old instance");
    runtime.setActivePluginRegistry(replacement);
    expect(recordAuthority()).toBe(false);
    expect(() => oldCall()).toThrow(/reloaded|disabled/);
    expect(newCall()).toBe("new instance");
    runtime.setActivePluginRegistry(original);
    expect(recordAuthority()).toBe(false);
    expect(() => oldCall()).toThrow(/reloaded|disabled/);
    expect(() => newCall()).toThrow(/reloaded|disabled/);
  } finally {
    await runtime.clearActivePluginRegistry();
    await Promise.all(
      [original, replacement].map((registry) => runtime.disposePluginRegistryInstances(registry)),
    );
  }
});

it("does not retire a registry or sibling record when one record is revoked", () => {
  const { registry, record: first } = registryWithRecord();
  const sibling = createPluginRecord({ id: "sibling-owner" });
  registry.plugins.push(sibling);
  markActive(registry);
  const { epoch, signal } = captureActivation(registry);

  revokePluginRecord(registry, first);

  expect(isRecordActive(registry, first)).toBe(false);
  expect(isRecordActive(registry, sibling)).toBe(true);
  expect(isEpochActive(registry, epoch)).toBe(true);
  expect(signal.aborted).toBe(false);
});

it.each(["commit", "rollback"] as const)(
  "retires only the abandoned activation after staged %s",
  (action) => {
    const original = createEmptyPluginRegistry();
    const candidate = createEmptyPluginRegistry();
    runtime.setActivePluginRegistry(original);
    const first = captureActivation(original);
    const snapshot = runtime.captureActivePluginRegistrySnapshot();

    runtime.stageActivePluginRegistry(candidate, "candidate", "default");
    const second = captureActivation(candidate);
    expect(first.signal.aborted).toBe(false);

    if (action === "commit") {
      runtime.commitStagedPluginRegistry(original, candidate);
    } else {
      runtime.rollbackStagedPluginRegistry(snapshot);
    }

    expect(first.signal.aborted).toBe(action === "commit");
    expect(second.signal.aborted).toBe(action === "rollback");
    const retained = action === "commit" ? second : first;
    const current = captureActivation(action === "commit" ? candidate : original);
    expect(current.epoch).toBe(retained.epoch);
    expect(current.signal).toBe(retained.signal);
  },
);

it("lists only unpublished cached registries as retiring with their cache", async () => {
  const cache = createPluginCache();
  const published = callableRegistry("published");
  markActive(published.registry);
  const lazy = callableRegistry("lazy");
  getPluginLoaderCacheState(cache).set("published", published.registry);
  getPluginLoaderCacheState(cache).set("lazy", lazy.registry);
  try {
    expect(listPluginCacheRetiringRegistries(cache)).toEqual([lazy.registry]);
  } finally {
    await retirePluginCache(cache);
  }
  expect(published.call()).toBe("published");
});
