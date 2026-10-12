import { expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  setGatewayPluginMetadataSnapshot,
  withPluginMetadataSnapshotScope,
} from "./current-plugin-metadata-snapshot.js";
import {
  getCurrentPluginMetadataSnapshotState,
  setCurrentPluginMetadataSnapshotState,
} from "./current-plugin-metadata-state.js";
import {
  createPluginCache,
  getPluginCache,
  retainPluginCache,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  clearPluginMetadataLifecycleCaches,
  registerPluginMetadataProcessMemoLifecycleClear,
  retainGatewayPluginMetadata,
} from "./plugin-metadata-lifecycle.js";
import { snapshotReaderSlot } from "./plugin-metadata-snapshot-readers.js";
import { getCurrentPluginMetadataSnapshotRequiredRuntime } from "./plugin-metadata-snapshot-required.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

const clearMemo = vi.fn();
registerPluginMetadataProcessMemoLifecycleClear(clearMemo);

it("retains running metadata readers through Gateway close after package replacement", async () => {
  const readers = { ...snapshotReaderSlot };
  const cache = getPluginCache();
  const owner = retainGatewayPluginMetadata(createTestGatewayScheduler());
  const snapshot = owner.runBootstrap(() => createPluginMetadataSnapshotFixture());
  const scoped = owner.runBootstrap(() => createPluginMetadataSnapshotFixture());
  const replacementReader = () => {
    throw new TypeError("replacement installation cannot read the running scope state");
  };
  const closing = createDeferredCore();
  const releaseClose = createDeferredCore();
  let finalClose: Promise<unknown> | undefined;
  try {
    owner.publish(snapshot);
    setGatewayPluginMetadataSnapshot(snapshot);
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
    // Released modules register by assigning the shared slot directly.
    Object.assign(snapshotReaderSlot, { getCurrentPluginMetadataSnapshot: replacementReader });
    await drainGlobalSingletonLifecycleState("close");
    expect(getCurrentPluginMetadataSnapshotRequiredRuntime({})).toBe(snapshot);
    expect(
      withPluginMetadataSnapshotScope(scoped, () =>
        getCurrentPluginMetadataSnapshotRequiredRuntime({}),
      ),
    ).toBe(scoped);
    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBe(snapshot);
    expect(clearMemo).not.toHaveBeenCalled();
    expect(getPluginCache()).toBe(cache);
    finalClose = owner.close(async () => {
      closing.resolve();
      await releaseClose.promise;
    });
    await closing.promise;
    Object.assign(snapshotReaderSlot, { getCurrentPluginMetadataSnapshot: replacementReader });
    expect(getCurrentPluginMetadataSnapshotRequiredRuntime({})).toBe(snapshot);
    releaseClose.resolve();
    await finalClose;
    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBeUndefined();
    expect(clearMemo).toHaveBeenCalledOnce();
    expect(getPluginCache()).not.toBe(cache);
    await owner.close();
    expect(clearMemo).toHaveBeenCalledOnce();
    Object.assign(snapshotReaderSlot, { getCurrentPluginMetadataSnapshot: replacementReader });
    expect(() => getCurrentPluginMetadataSnapshotRequiredRuntime({})).toThrow(
      "replacement installation cannot read the running scope state",
    );
    for (const event of ["plugin-registry", "restart"] as const) {
      await drainGlobalSingletonLifecycleState(event);
      expect(() => getCurrentPluginMetadataSnapshotRequiredRuntime({})).toThrow(
        "replacement installation cannot read the running scope state",
      );
    }
    await drainGlobalSingletonLifecycleState("close");
    expect(snapshotReaderSlot.getCurrentPluginMetadataSnapshot).toBeUndefined();
    expect(snapshotReaderSlot.loadPluginMetadataSnapshot).toBeUndefined();
    expect(getCurrentPluginMetadataSnapshotRequiredRuntime({})).toBeUndefined();
  } finally {
    releaseClose.resolve();
    await (finalClose ?? owner.close());
    Object.assign(snapshotReaderSlot, readers);
  }
});

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
  const owner = retainGatewayPluginMetadata(createTestGatewayScheduler());
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
    expect(() => retainGatewayPluginMetadata(createTestGatewayScheduler())).toThrow(/retir|shut/i);
    cleanupReleased.resolve();
    await sharedEntered.promise;
    expect(getPluginCache()).toBe(cache);
    expect(() => retainGatewayPluginMetadata(createTestGatewayScheduler())).toThrow(/retir|shut/i);
    sharedReleased.resolve();
    await closing;
    await owner.close(finalCleanup);
    expect(finalCleanup).toHaveBeenCalledOnce();
    const next = retainGatewayPluginMetadata(createTestGatewayScheduler());
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

it.each([false, true])(
  "refreshes bootstrap facts only before publication (%s)",
  async (published) => {
    const owner = retainGatewayPluginMetadata(createTestGatewayScheduler());
    const cache = owner.runBootstrap(getPluginCache);
    try {
      if (published) {
        owner.publish(undefined);
        await owner.waitForRetirement();
      } else {
        setCurrentPluginMetadataSnapshotState(createPluginMetadataSnapshotFixture(), "planning");
      }
      clearPluginMetadataLifecycleCaches();
      if (published) {
        expect(getPluginCache()).toBe(cache);
        const releaseFacts = retainPluginCache(cache);
        releaseFacts();
      } else {
        expect(getCurrentPluginMetadataSnapshotState().snapshot).toBeUndefined();
      }
    } finally {
      await owner.close();
    }
    expect(getPluginCache()).not.toBe(cache);
  },
);

it.each([true, false])(
  "observes deferred turn cleanup and joins it on shutdown (borrowed: %s)",
  async (borrowed) => {
    const cache = getPluginCache();
    const release = borrowed ? retainPluginCache(cache) : () => {};
    const owner = retainGatewayPluginMetadata(createTestGatewayScheduler());
    owner.publish(owner.runBootstrap(() => createPluginMetadataSnapshotFixture()));
    const next = withPluginCache(createPluginCache(), () => createPluginMetadataSnapshotFixture());
    const failure = {
      pluginId: "turn-owner",
      hookId: "instance",
      error: new Error("cleanup failed"),
    };
    const completed = { cleanupCount: 1, failures: [failure] };
    const cleanup = createDeferredCore<typeof completed>();
    owner.publish(next, new Set(["turn-owner"]), (options?: { deferConsumers?: true }) =>
      options?.deferConsumers
        ? Promise.resolve({ cleanupCount: 0, failures: [], deferredPluginIds: ["turn-owner"] })
        : cleanup.promise,
    );
    let published = false;
    const publication = owner.waitForRetirement().then((result) => {
      published = true;
      return result;
    });
    try {
      await expect.poll(() => published).toBe(true);
      expect(await publication).toEqual({
        cleanupCount: 0,
        failures: [],
        deferredPluginIds: ["turn-owner"],
      });
      expect(cache.retirement).toBeUndefined();
      await owner.beginClose();
      let joined = false;
      const shutdown = owner.close().then((result) => {
        joined = true;
        return result;
      });
      await Promise.resolve();
      expect(joined).toBe(false);
      release();
      cleanup.resolve(completed);
      expect(await shutdown).toEqual(completed);
    } finally {
      release();
      cleanup.resolve(completed);
      await publication;
      await owner.close();
    }
  },
);

it.each([false, true])(
  "settles publication and reports cleanup failures (released before final close: %s)",
  async (releasedBeforeClose) => {
    const cache = getPluginCache();
    const instance = new PluginInstance("retained-publication");
    const failure = new Error("retained consumer cleanup failed");
    const dispose = vi.fn();
    instance.lifecycle.onDispose(dispose);
    cache.setupModules.set("retained-publication", instance);
    const release = retainPluginCache(cache);
    const owner = retainGatewayPluginMetadata(createTestGatewayScheduler());
    owner.publish(owner.runBootstrap(() => createPluginMetadataSnapshotFixture()));
    owner.publish(
      withPluginCache(createPluginCache(), () => createPluginMetadataSnapshotFixture()),
      new Set(["retained-publication"]),
      async (options) =>
        options?.deferConsumers
          ? { cleanupCount: 0, failures: [], deferredPluginIds: ["retained-publication"] }
          : {
              cleanupCount: 1,
              failures: [{ pluginId: "retained-publication", hookId: "instance", error: failure }],
            },
    );
    await owner.beginClose();
    const publication = owner.waitForRetirement();
    let closing: Promise<unknown> | undefined;
    try {
      await withTestTimeout(publication, 1_000, "Publication waited for its retained consumer");
      expect(dispose).not.toHaveBeenCalled();
      if (releasedBeforeClose) {
        release();
        await retirePluginCache(cache);
        expect(dispose).toHaveBeenCalledOnce();
      }
      const finalEntered = createDeferredCore();
      let closed = false;
      closing = owner
        .close(async (retire) => {
          finalEntered.resolve();
          await retire();
        })
        .then(() => {
          closed = true;
        });
      await finalEntered.promise;
      expect(closed).toBe(false);
      if (!releasedBeforeClose) {
        expect(dispose).not.toHaveBeenCalled();
      }
      release();
      await closing;
      expect((await owner.close()).failures).toEqual([
        expect.objectContaining({ pluginId: "retained-publication", error: failure }),
      ]);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      release();
      await Promise.allSettled([publication, closing ?? owner.close()]);
    }
  },
);
