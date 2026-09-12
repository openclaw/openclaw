import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import {
  createPluginCache,
  getPluginCacheRetirementSignal,
  retirePluginCache,
} from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { disposePluginRegistryInstances, waitForPluginRegistryRetirement } from "./runtime.js";

const emptyResult = { cleanupCount: 0, failures: [] };

async function collect() {
  const gc = globalThis.gc;
  assert.ok(gc, "The retention child requires --expose-gc");
  const control = new WeakRef({ unowned: true });
  for (let pass = 0; pass < 8; pass += 1) {
    await setImmediate();
    gc();
  }
  assert.equal(control.deref(), undefined, "Unowned control must collect");
}

async function retireSuccessors() {
  const oldest = createEmptyPluginRegistry();
  const successors: WeakRef<ReturnType<typeof createEmptyPluginRegistry>>[] = [];
  let previous = oldest;
  for (let generation = 0; generation < 3; generation += 1) {
    const next = createEmptyPluginRegistry();
    successors.push(new WeakRef(next));
    assert.deepEqual(
      await disposePluginRegistryInstances(previous, next, { cfg: {} }),
      emptyResult,
    );
    assert.deepEqual(await waitForPluginRegistryRetirement(previous), emptyResult);
    previous = next;
  }
  return { oldest, successors };
}

async function retireCapturedCallback() {
  const marker = { label: "startup-only retirement capture" };
  const reference = new WeakRef(marker);
  const cache = createPluginCache();
  const signal = getPluginCacheRetirementSignal(cache);
  let calls = 0;
  const beforeRetire = () => {
    assert.equal(marker.label, "startup-only retirement capture");
    calls += 1;
  };
  // Match a lifecycle caller whose stack frame closes over the retirement callback.
  const retire = () => retirePluginCache(cache, beforeRetire);
  assert.deepEqual(await retire(), emptyResult);
  assert.equal(calls, 1);
  return { cache, signal, reference };
}

async function retireCapturedSource() {
  const instance = new PluginInstance("source-retention");
  const source = { path: "captured-source" };
  const reference = new WeakRef(source);
  instance.bindModuleLoader(
    () => 42,
    (path) => path === source.path,
  );
  assert.equal(instance.hasModuleSource(source.path), true);
  assert.equal(instance.loadModule(source.path), 42);
  await instance.dispose();
  return { instance, reference };
}

switch (process.argv[2]) {
  case "formatter": {
    const cache = createPluginCache();
    const formatter = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
    const failure = new Error("synthetic stack formatter failure");
    let calls = 0;
    try {
      Error.prepareStackTrace = () => {
        throw failure;
      };
      assert.deepEqual(await retirePluginCache(cache, () => calls++), emptyResult);
    } finally {
      if (formatter) {
        Object.defineProperty(Error, "prepareStackTrace", formatter);
      } else {
        Reflect.deleteProperty(Error, "prepareStackTrace");
      }
    }
    assert.equal(calls, 1);
    assert.equal(getPluginCacheRetirementSignal(cache).aborted, true);
    break;
  }
  case "instance": {
    const { instance, reference } = await retireCapturedSource();
    await collect();
    assert.equal(reference.deref(), undefined, "Disposed instance retained its source lookup");
    assert.equal(instance.hasModuleSource("captured-source"), false);
    assert.throws(() => instance.loadModule("captured-source"), /reloaded or disabled/);
    const neverBound = new PluginInstance("never-bound");
    await neverBound.dispose();
    assert.equal(neverBound.hasModuleSource("library"), undefined);
    break;
  }
  case "registry": {
    const { oldest, successors } = await retireSuccessors();
    await collect();
    assert.ok(
      successors.every((reference) => reference.deref() === undefined),
      "Completed retirement retained a successor registry",
    );
    assert.deepEqual(await waitForPluginRegistryRetirement(oldest), emptyResult);
    assert.deepEqual(await disposePluginRegistryInstances(oldest), emptyResult);
    break;
  }
  case "cache": {
    const { cache, signal, reference } = await retireCapturedCallback();
    await collect();
    assert.equal(reference.deref(), undefined, "Retired cache retained its callback capture");
    assert.equal(getPluginCacheRetirementSignal(cache), signal);
    assert.equal(signal.aborted, true);
    const reason: unknown = signal.reason;
    const defaultReason: unknown = AbortSignal.abort().reason;
    assert.ok(reason instanceof DOMException);
    assert.ok(defaultReason instanceof DOMException);
    assert.equal(reason.name, defaultReason.name);
    assert.equal(reason.code, defaultReason.code);
    assert.equal(reason.message, defaultReason.message);
    assert.equal(typeof reason.stack, "string");
    assert.throws(
      () => signal.throwIfAborted(),
      (error) => error === reason,
    );
    assert.deepEqual(await retirePluginCache(cache), emptyResult);
    const other = createPluginCache();
    await retirePluginCache(other);
    assert.notEqual(getPluginCacheRetirementSignal(other).reason, reason);
    break;
  }
  default:
    throw new Error("Expected registry, cache, instance, or formatter retention scenario");
}
