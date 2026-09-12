import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import {
  getCurrentPluginMetadataSnapshotState,
  selectCurrentPluginMetadataCache,
  setCurrentPluginMetadataSnapshotState,
} from "./current-plugin-metadata-state.js";
import {
  createPluginCache,
  getPluginCache,
  getProcessPluginCache,
  retainPluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  clearPluginMetadataLifecycleCaches,
  registerPluginMetadataProcessMemoLifecycleClear,
  retainGatewayPluginMetadata,
} from "./plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

const clearMemo = vi.fn();
registerPluginMetadataProcessMemoLifecycleClear(clearMemo);

it("joins owned cleanup and final shared teardown before admitting another Gateway", async () => {
  const cache = getPluginCache();
  const instance = new PluginInstance("metadata-cleanup");
  const cleanupEntered = createDeferredCore();
  const cleanupReleased = createDeferredCore();
  const sharedEntered = createDeferredCore();
  const sharedReleased = createDeferredCore();
  instance.lifecycle.onDispose(async () => {
    cleanupEntered.resolve();
    await cleanupReleased.promise;
  });
  cache.setupModules.set("metadata-cleanup", instance);
  const owner = retainGatewayPluginMetadata();
  let sharedStarted = false;
  const finalCleanup = vi.fn(async (retire: () => Promise<unknown>) => {
    await retire();
    sharedStarted = true;
    sharedEntered.resolve();
    await sharedReleased.promise;
  });
  const closing = owner.close(finalCleanup);
  try {
    await cleanupEntered.promise;
    expect(sharedStarted).toBe(false);
    expect(getPluginCache()).toBe(cache);
    expect(() => retainGatewayPluginMetadata()).toThrow(/retir|shut/i);
    cleanupReleased.resolve();
    await sharedEntered.promise;
    expect(getPluginCache()).toBe(cache);
    expect(() => retainGatewayPluginMetadata()).toThrow(/retir|shut/i);
    sharedReleased.resolve();
    await closing;
    await owner.close(finalCleanup);
    expect(finalCleanup).toHaveBeenCalledOnce();
    const next = retainGatewayPluginMetadata();
    try {
      expect(getPluginCache()).not.toBe(cache);
    } finally {
      await next.close();
    }
  } finally {
    cleanupReleased.resolve();
    sharedReleased.resolve();
    await closing;
  }
});

it("keeps boot metadata and process memos until the final Gateway releases them", async () => {
  const firstAccessCache = getPluginCache();
  const first = retainGatewayPluginMetadata();
  const second = retainGatewayPluginMetadata();
  try {
    const snapshot = first.runBootstrap(() => createPluginMetadataSnapshotFixture());
    first.publish(snapshot);
    second.publish(snapshot);
    setCurrentPluginMetadataSnapshotState(
      snapshot,
      "boot",
      undefined,
      undefined,
      undefined,
      "gateway",
    );
    clearMemo.mockClear();

    clearPluginMetadataLifecycleCaches();
    await second.close();
    await second.close();

    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBe(snapshot);
    expect(clearMemo).not.toHaveBeenCalled();
    expect(getPluginCache()).toBe(firstAccessCache);

    await first.close();
    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBeUndefined();
    expect(clearMemo).toHaveBeenCalledOnce();
    expect(getPluginCache()).not.toBe(firstAccessCache);
    await first.close();
    expect(clearMemo).toHaveBeenCalledOnce();
  } finally {
    await Promise.all([second.close(), first.close()]);
  }
});

it("allows startup planning metadata to refresh before a Gateway inventory is published", async () => {
  const owner = retainGatewayPluginMetadata();
  try {
    setCurrentPluginMetadataSnapshotState(createPluginMetadataSnapshotFixture(), "planning");
    clearPluginMetadataLifecycleCaches();
    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBeUndefined();
  } finally {
    await owner.close();
  }
});

it("keeps bootstrap facts usable when no replacement metadata snapshot is published", async () => {
  const owner = retainGatewayPluginMetadata();
  const cache = owner.runBootstrap(getPluginCache);
  try {
    owner.publish(undefined);
    await owner.waitForRetirement();
    clearPluginMetadataLifecycleCaches();
    expect(getPluginCache()).toBe(cache);
    const releaseFacts = retainPluginCache(cache);
    releaseFacts();
  } finally {
    await owner.close();
  }
  expect(getPluginCache()).not.toBe(cache);
});

it("fences admission before retirement while an admitted sibling stays usable", async () => {
  const cache = getPluginCache();
  const first = retainGatewayPluginMetadata();
  const sibling = retainGatewayPluginMetadata();
  const instance = new PluginInstance("sibling-inventory");
  const callback = instance.wrap(() => "still-live");
  cache.setupModules.set("sibling-inventory", instance);
  const finalCleanup = vi.fn();
  const snapshot = first.runBootstrap(() => createPluginMetadataSnapshotFixture());
  first.publish(snapshot);
  sibling.publish(snapshot);
  setGatewayPluginMetadataSnapshot(snapshot);
  clearMemo.mockClear();
  first.beginClose();
  try {
    expect(() => retainGatewayPluginMetadata()).toThrow(/shut/i);
    expect(cache.retirement).toBeUndefined();
    expect(callback()).toBe("still-live");
    clearPluginMetadataLifecycleCaches();
    await first.close(finalCleanup);
    expect(finalCleanup).not.toHaveBeenCalled();
    expect(getPluginCache()).toBe(cache);
    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBe(snapshot);
    expect(clearMemo).not.toHaveBeenCalled();
    expect(callback()).toBe("still-live");
    const newcomer = retainGatewayPluginMetadata();
    await newcomer.close();
    await sibling.close();
    expect(clearMemo).toHaveBeenCalledOnce();
    expect(() => callback()).toThrow();
  } finally {
    await Promise.all([first.close(), sibling.close()]);
  }
});

function retainDistinctMetadataOwners() {
  const firstCache = getPluginCache();
  const first = retainGatewayPluginMetadata();
  onTestFinished(() => first.close());
  const firstSnapshot = first.runBootstrap(() => createPluginMetadataSnapshotFixture());
  first.publish(firstSnapshot);
  selectCurrentPluginMetadataCache(firstCache);
  setGatewayPluginMetadataSnapshot(firstSnapshot);
  const secondCache = createPluginCache();
  const second = withPluginCache(secondCache, () => retainGatewayPluginMetadata());
  onTestFinished(() => second.close());
  const secondSnapshot = second.runBootstrap(() => createPluginMetadataSnapshotFixture());
  second.publish(secondSnapshot);
  selectCurrentPluginMetadataCache(secondCache);
  setGatewayPluginMetadataSnapshot(secondSnapshot);
  return { first, firstCache, second, secondCache };
}

it("keeps final inventory usable before joining concurrent cache retirements", async () => {
  const { first, firstCache, second, secondCache } = retainDistinctMetadataOwners();
  const firstEntered = createDeferredCore();
  const firstReleased = createDeferredCore();
  const finalEntered = createDeferredCore();
  const finalReleased = createDeferredCore();
  const secondDisposed = createDeferredCore();
  const firstInstance = new PluginInstance("first-inventory");
  const secondInstance = new PluginInstance("last-inventory");
  firstCache.setupModules.set("first", firstInstance);
  secondCache.setupModules.set("last", secondInstance);
  firstInstance.lifecycle.onDispose(async () => {
    firstEntered.resolve();
    await firstReleased.promise;
  });
  secondInstance.lifecycle.onDispose(() => secondDisposed.resolve());
  const useFinalDependency = secondInstance.wrap(() => "available");
  const firstFinal = vi.fn();
  let sharedClosed = false;
  const lastFinal = vi.fn(async (retire: () => Promise<void>) => {
    finalEntered.resolve();
    await finalReleased.promise;
    await retire();
    sharedClosed = true;
  });
  const firstClose = first.close(firstFinal);
  const secondClose = second.close(lastFinal);
  try {
    await Promise.race([finalEntered.promise, secondDisposed.promise]);
    expect(secondCache.retirement).toBeUndefined();
    expect(useFinalDependency()).toBe("available");
    expect(firstFinal).not.toHaveBeenCalled();
    expect(lastFinal).toHaveBeenCalledOnce();
    await firstEntered.promise;
    finalReleased.resolve();
    await secondDisposed.promise;
    expect(sharedClosed).toBe(false);
    firstReleased.resolve();
    await Promise.all([firstClose, secondClose]);
    expect(sharedClosed).toBe(true);
    expect(() => useFinalDependency()).toThrow();
    expect(lastFinal).toHaveBeenCalledOnce();
  } finally {
    firstReleased.resolve();
    finalReleased.resolve();
    await Promise.allSettled([firstClose, secondClose]);
  }
});

it("selects a closing sibling's still-bound cache until its retirement begins", async () => {
  const { first, firstCache, second, secondCache } = retainDistinctMetadataOwners();
  const instance = new PluginInstance("closing-sibling");
  secondCache.setupModules.set("closing-sibling", instance);
  const useDependency = instance.wrap(() => "available");
  selectCurrentPluginMetadataCache(firstCache);
  second.beginClose();
  const finalCleanup = vi.fn();
  try {
    await first.close(finalCleanup);
    expect(firstCache.retirement).toBeDefined();
    expect(getProcessPluginCache()).toBe(secondCache);
    expect(secondCache.retirement).toBeUndefined();
    expect(useDependency()).toBe("available");
    expect(finalCleanup).not.toHaveBeenCalled();
    expect(() => retainGatewayPluginMetadata()).toThrow(/shut/i);
    await second.close(finalCleanup);
    expect(finalCleanup).toHaveBeenCalledOnce();
    expect(() => useDependency()).toThrow();
  } finally {
    await Promise.allSettled([first.close(), second.close()]);
  }
});
