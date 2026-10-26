import { expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { createEnteredGate as gate } from "../agents/entered-gate.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { createTestGatewayScheduler as createScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  setGatewayPluginMetadataSnapshot,
  withPluginMetadataSnapshotScope as withSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import {
  getCurrentPluginMetadataSnapshotState as snapshotState,
  setCurrentPluginMetadataSnapshotState as setSnapshot,
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
  retainGatewayPluginMetadata as retainMetadata,
} from "./plugin-metadata-lifecycle.js";
import { snapshotReaderSlot } from "./plugin-metadata-snapshot-readers.js";
import {
  getCurrentPluginMetadataSnapshotRequiredRuntime as currentSnapshot,
  listKnownProviderAuthEnvVarNamesRuntime,
  listOpenClawPluginManifestMetadataRuntime,
} from "./plugin-metadata-snapshot-required.js";
import { createPluginMetadataSnapshotFixture as createSnapshot } from "./plugin-metadata.test-support.js";

const clearMemo = vi.fn();
registerPluginMetadataProcessMemoLifecycleClear(clearMemo);

it("retains running metadata readers through Gateway close after package replacement", async () => {
  const readers = { ...snapshotReaderSlot };
  const manifests = [{ pluginDir: "/fixture", manifest: { id: "fixture" }, origin: "bundled" }];
  const envNames = ["FIXTURE_API_KEY"];
  Object.assign(snapshotReaderSlot, {
    listOpenClawPluginManifestMetadata: () => manifests,
    listKnownProviderAuthEnvVarNamesCore: () => envNames,
  });
  const cache = getPluginCache();
  const owner = retainMetadata(createScheduler());
  const snapshot = owner.runBootstrap(createSnapshot);
  const scoped = owner.runBootstrap(createSnapshot);
  const replacementError = "replacement installation cannot read the running scope state";
  const replacementReader = () => {
    throw new TypeError(replacementError);
  };
  const replacementReaders = {
    getCurrentPluginMetadataSnapshot: replacementReader,
    listOpenClawPluginManifestMetadata: replacementReader,
    listKnownProviderAuthEnvVarNamesCore: replacementReader,
  };
  const expectRetainedPolicyReaders = () => {
    expect(currentSnapshot({})).toBe(snapshot);
    expect(listOpenClawPluginManifestMetadataRuntime()).toBe(manifests);
    expect(listKnownProviderAuthEnvVarNamesRuntime()).toBe(envNames);
  };
  const closing = gate();
  let finalClose: Promise<unknown> | undefined;
  try {
    owner.publish(snapshot);
    setGatewayPluginMetadataSnapshot(snapshot);
    setSnapshot(snapshot, "boot", undefined, undefined, "gateway");
    clearMemo.mockClear();
    clearPluginMetadataLifecycleCaches();
    // Released modules register by assigning the shared slot directly.
    Object.assign(snapshotReaderSlot, replacementReaders);
    await drainGlobalSingletonLifecycleState("close");
    expectRetainedPolicyReaders();
    expect(withSnapshot(scoped, () => currentSnapshot({}))).toBe(scoped);
    expect(snapshotState().snapshot).toBe(snapshot);
    expect(clearMemo).not.toHaveBeenCalled();
    expect(getPluginCache()).toBe(cache);
    finalClose = owner.close(closing.wait);
    await closing.entered;
    Object.assign(snapshotReaderSlot, replacementReaders);
    expectRetainedPolicyReaders();
    closing.release();
    await finalClose;
    expect(snapshotState().snapshot).toBeUndefined();
    expect(clearMemo).toHaveBeenCalledOnce();
    expect(getPluginCache()).not.toBe(cache);
    await owner.close();
    expect(clearMemo).toHaveBeenCalledOnce();
    Object.assign(snapshotReaderSlot, replacementReaders);
    for (const read of [
      () => currentSnapshot({}),
      listOpenClawPluginManifestMetadataRuntime,
      listKnownProviderAuthEnvVarNamesRuntime,
    ]) {
      expect(read).toThrow(replacementError);
    }
    for (const event of ["plugin-registry", "restart"] as const) {
      await drainGlobalSingletonLifecycleState(event);
      expect(() => currentSnapshot({})).toThrow(replacementError);
    }
    await drainGlobalSingletonLifecycleState("close");
    expect(snapshotReaderSlot.getCurrentPluginMetadataSnapshot).toBeUndefined();
    expect(snapshotReaderSlot.loadPluginMetadataSnapshot).toBeUndefined();
    expect(snapshotReaderSlot.listOpenClawPluginManifestMetadata).toBeUndefined();
    expect(snapshotReaderSlot.listKnownProviderAuthEnvVarNamesCore).toBeUndefined();
    expect(currentSnapshot({})).toBeUndefined();
  } finally {
    closing.release();
    await (finalClose ?? owner.close());
    Object.assign(snapshotReaderSlot, readers);
    for (const key of [
      "listOpenClawPluginManifestMetadata",
      "listKnownProviderAuthEnvVarNamesCore",
    ] as const) {
      if (!Object.hasOwn(readers, key)) {
        delete snapshotReaderSlot[key];
      }
    }
  }
});

it("joins owned cleanup and final shared teardown before admitting another Gateway", async () => {
  const cache = getPluginCache();
  const instance = new PluginInstance("metadata-cleanup");
  const cleanup = gate();
  const shared = gate();
  instance.lifecycle.onDispose(cleanup.wait);
  cache.setupModules.set("metadata-cleanup", instance);
  const owner = retainMetadata(createScheduler());
  let sharedStarted = false;
  const finalCleanup = vi.fn(async (retire: () => Promise<unknown>) => {
    await retire();
    sharedStarted = true;
    await shared.wait();
  });
  const closing = owner.close(finalCleanup);
  try {
    await cleanup.entered;
    expect(sharedStarted).toBe(false);
    expect(getPluginCache()).toBe(cache);
    expect(() => retainMetadata(createScheduler())).toThrow(/retir|shut/i);
    cleanup.release();
    await shared.entered;
    expect(getPluginCache()).toBe(cache);
    expect(() => retainMetadata(createScheduler())).toThrow(/retir|shut/i);
    shared.release();
    await closing;
    await owner.close(finalCleanup);
    expect(finalCleanup).toHaveBeenCalledOnce();
    const next = retainMetadata(createScheduler());
    try {
      expect(getPluginCache()).not.toBe(cache);
    } finally {
      await next.close();
    }
  } finally {
    cleanup.release();
    shared.release();
    await closing;
  }
});

it.each([false, true])(
  "refreshes bootstrap facts only before publication (%s)",
  async (published) => {
    const owner = retainMetadata(createScheduler());
    const cache = owner.runBootstrap(getPluginCache);
    try {
      if (published) {
        owner.publish(undefined);
        await owner.waitForRetirement();
      } else {
        setSnapshot(createSnapshot(), "planning");
      }
      clearPluginMetadataLifecycleCaches();
      if (published) {
        expect(getPluginCache()).toBe(cache);
        const releaseFacts = retainPluginCache(cache);
        releaseFacts();
      } else {
        expect(snapshotState().snapshot).toBeUndefined();
      }
    } finally {
      await owner.close();
    }
    expect(getPluginCache()).not.toBe(cache);
  },
);

it.each([
  { borrowed: true, deferred: true, releasedBeforeClose: false },
  { borrowed: false, deferred: true, releasedBeforeClose: false },
  { borrowed: true, deferred: false, releasedBeforeClose: false },
  { borrowed: true, deferred: false, releasedBeforeClose: true },
])(
  "settles retirement (borrowed: $borrowed, deferred: $deferred, early release: $releasedBeforeClose)",
  async ({ borrowed, deferred, releasedBeforeClose }) => {
    const cache = getPluginCache();
    const pluginId = deferred ? "turn-owner" : "retained-publication";
    const dispose = vi.fn();
    if (!deferred) {
      const instance = new PluginInstance(pluginId);
      instance.lifecycle.onDispose(dispose);
      cache.setupModules.set(pluginId, instance);
    }
    const release = borrowed ? retainPluginCache(cache) : () => {};
    const owner = retainMetadata(createScheduler());
    owner.publish(owner.runBootstrap(createSnapshot));
    const failure = { pluginId, hookId: "instance", error: new Error("cleanup failed") };
    const completed = { cleanupCount: 1, failures: [failure] };
    const cleanup = createDeferredCore<typeof completed>();
    if (!deferred) {
      cleanup.resolve(completed);
    }
    owner.publish(
      withPluginCache(createPluginCache(), createSnapshot),
      new Set([pluginId]),
      (options) =>
        options?.deferConsumers
          ? Promise.resolve({ cleanupCount: 0, failures: [], deferredPluginIds: [pluginId] })
          : cleanup.promise,
    );
    if (!deferred) {
      await owner.beginClose();
    }
    const publication = owner.waitForRetirement();
    let closing: Promise<unknown> | undefined;
    try {
      await withTestTimeout(publication, 1_000, "Publication waited for its retained consumer");
      if (deferred) {
        expect(await publication).toEqual({
          cleanupCount: 0,
          failures: [],
          deferredPluginIds: ["turn-owner"],
        });
        expect(cache.retirement).toBeUndefined();
        await owner.beginClose();
      } else {
        expect(dispose).not.toHaveBeenCalled();
        if (releasedBeforeClose) {
          release();
          await retirePluginCache(cache);
          expect(dispose).toHaveBeenCalledOnce();
        }
      }
      const finalEntered = createDeferredCore();
      let closed = false;
      closing = owner
        .close(
          deferred
            ? undefined
            : async (retire) => {
                finalEntered.resolve();
                await retire();
              },
        )
        .then((result) => {
          closed = true;
          return result;
        });
      await (deferred ? Promise.resolve() : finalEntered.promise);
      expect(closed).toBe(false);
      if (!deferred && !releasedBeforeClose) {
        expect(dispose).not.toHaveBeenCalled();
      }
      release();
      cleanup.resolve(completed);
      if (deferred) {
        expect(await closing).toEqual(completed);
      } else {
        await closing;
        expect((await owner.close()).failures).toEqual([
          expect.objectContaining({ pluginId: "retained-publication", error: failure.error }),
        ]);
        expect(dispose).toHaveBeenCalledOnce();
      }
    } finally {
      release();
      cleanup.resolve(completed);
      await Promise.allSettled([publication, closing ?? owner.close()]);
    }
  },
);
