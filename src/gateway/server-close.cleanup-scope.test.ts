import "./server-worker-free.test-support.js";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOwnedInstance } from "../plugins/plugin-instance.test-support.js";
import { retainGatewayPluginMetadata } from "../plugins/plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getPluginLoaderCacheState } from "../plugins/registry-lifecycle.js";
import {
  createPluginRegistryOwner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { runWithProcessCleanupBudget } from "../process/supervisor/cleanup-budget.js";
import { registerActiveDebugProxyCapture } from "../proxy-capture/runtime-cleanup.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { completeGatewayClose, prepareGatewayClose } from "./server-close.js";
import { createGatewayCloseTestDepsFactory } from "./server-close.test-support.js";
import { GatewayConnectionWork } from "./server-connection-work.js";

const sharedStateLifecycle = resolveGlobalMap<string, boolean>(
  Symbol("gateway-close-cleanup-shared-state"),
  "shared-state",
);

const createGatewayCloseTestDeps = createGatewayCloseTestDepsFactory({
  disposeAllBundleLspRuntimes: async () => {},
  stopGmailWatcher: async () => {},
  disposeAllCodeModeRuns: async () => {},
  closeProviderTransportDispatcherPool: async () => {},
  drainRetainedEmbeddingProviders: async () => {},
});

function closeGateway(
  params = createGatewayCloseTestDeps(),
  options: Parameters<typeof prepareGatewayClose>[1] = { reason: "test" },
) {
  return prepareGatewayClose(params, options).then((preparation) =>
    completeGatewayClose(params, preparation),
  );
}

async function observeMediaDrain(entered: Deferred) {
  const media = await import("./server-media-cleanup-lifecycle.js");
  const wait = media.waitForMediaCleanupDrainsToSettle;
  vi.spyOn(media, "waitForMediaCleanupDrainsToSettle").mockImplementation(() => {
    entered.resolve();
    return wait();
  });
  return wait;
}

beforeEach(() => {
  sharedStateLifecycle.set("open", true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});

it.each(["rejected", "slow", "timed out"])(
  "closes its listener and resources after restart marker persistence %s",
  async (outcome) => {
    const { listener, releaseListener, claim } = await reserveTestPortListener({
      offsets: [0],
      createListener: () => createServer(),
    });
    const entered = createDeferredCore();
    const committed = createDeferredCore();
    const params = createGatewayCloseTestDeps({
      httpServer: listener,
      channelIds: ["telegram"],
      persistRunningSessionsForRestart: async (signal) => {
        entered.resolve();
        if (outcome === "rejected") {
          throw new Error("marker store refused");
        }
        await committed.promise;
        signal.throwIfAborted();
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const closing = runWithProcessCleanupBudget(
      { deadline: performance.now() + 2_000, warn() {} },
      () => closeGateway(params).catch((error: unknown) => error),
    );
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(outcome === "timed out" ? 2_000 : 1_100);
      committed.resolve();
      expect(await closing).toMatchObject(
        outcome === "slow"
          ? { warnings: [] }
          : outcome === "rejected"
            ? new Error("marker store refused")
            : new Error("Shutdown session persistence did not settle within 2000ms"),
      );
      expect(listener.listening).toBe(false);
      expect(params.stopChannel).toHaveBeenCalledWith("telegram");
      expect(sharedStateLifecycle.size).toBe(0);
    } finally {
      committed.resolve();
      vi.useRealTimers();
      if (listener.listening) {
        await releaseListener();
      }
      await claim.release();
    }
  },
);

it("finalizes capture after media drains even when stopping media cleanup fails", async () => {
  const mediaCleanup = await import("./server-media-cleanup-lifecycle.js");
  const releaseMedia = createDeferredCore();
  const drainEntered = createDeferredCore();
  mediaCleanup.registerMediaCleanupDrain(releaseMedia.promise);
  await observeMediaDrain(drainEntered);
  const captureEntered = createDeferredCore();
  const releaseCapture = createDeferredCore();
  const finalizeCapture = vi.fn(async () => {
    captureEntered.resolve();
    await releaseCapture.promise;
  });
  const unregisterCapture = registerActiveDebugProxyCapture(finalizeCapture);
  const registry = createEmptyPluginRegistry();
  setActivePluginRegistry(registry);
  const owner = createPluginRegistryOwner(registry);
  const params = createGatewayCloseTestDeps({
    closePluginRegistry: owner.close,
    pluginMetadata: retainGatewayPluginMetadata(createTestGatewayScheduler()),
    stopMediaCleanup: async () => {
      throw new Error("media cleanup stop failed");
    },
  });
  let closed = false;
  const closing = closeGateway(params).then((result) => {
    closed = true;
    return result;
  });
  try {
    await Promise.race([drainEntered.promise, captureEntered.promise, closing]);
    expect(finalizeCapture).not.toHaveBeenCalled();
    expect(closed).toBe(false);
    expect(sharedStateLifecycle.has("open")).toBe(true);
    releaseMedia.resolve();
    await Promise.race([captureEntered.promise, closing]);
    expect(finalizeCapture).toHaveBeenCalledOnce();
    expect(closed).toBe(false);
    releaseCapture.resolve();
    await expect(closing).resolves.toMatchObject({ warnings: ["media-cleanup"] });
    expect(sharedStateLifecycle.size).toBe(0);
  } finally {
    releaseMedia.resolve();
    releaseCapture.resolve();
    await closing.catch(() => {});
    unregisterCapture();
  }
});

it("owns plugin cleanup and its descendants after the requesting connection drains", async () => {
  const connectionWork = new GatewayConnectionWork();
  const requestContext = connectionWork.run(() => AsyncLocalStorage.snapshot());
  await connectionWork.drain();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const completed = vi.fn();
  const { registry, record, instance } = createOwnedInstance("drain-cleanup");
  const cleanup = vi.fn(async () => {
    await trackAsyncWork(async () => {});
    void trackAsyncWork(async () => {
      entered.resolve();
      await release.promise;
      expect(sharedStateLifecycle.has("open")).toBe(true);
      completed();
    });
  });
  registry.runtimeLifecycles.push({
    pluginId: record.id,
    pluginName: record.name,
    source: "drain-cleanup-fixture",
    lifecycle: { id: "async-cleanup", cleanup },
  });
  const metadata = retainGatewayPluginMetadata(createTestGatewayScheduler());
  getPluginLoaderCacheState().set("drain-cleanup", registry);
  const servingRegistry = createEmptyPluginRegistry();
  setActivePluginRegistry(servingRegistry);
  const owner = createPluginRegistryOwner(servingRegistry);
  const params = createGatewayCloseTestDeps({
    closePluginRegistry: owner.close,
    pluginMetadata: metadata,
  });
  const closing = requestContext(() =>
    closeGateway(params, { restartExpectedMs: 0, drainTimeoutMs: 0 }),
  );
  try {
    await Promise.race([entered.promise, closing]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(sharedStateLifecycle.has("open")).toBe(true);
    release.resolve();
    await expect(closing).resolves.toMatchObject({ warnings: [] });
    expect(instance.lifecycle.signal.aborted).toBe(true);
    expect(completed).toHaveBeenCalledOnce();
    expect(sharedStateLifecycle.size).toBe(0);
  } finally {
    release.resolve();
    await closing.catch(() => {});
  }
});

it("joins detached request attachment cleanup before shared state closes", async () => {
  const { withOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
  const attachments = await import("./chat-attachments.js");
  const mediaStore = await import("../media/store.js");
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const parsed = await attachments.parseMessageWithAttachments(
      "read this",
      [
        {
          type: "file",
          mimeType: "text/plain",
          fileName: "cleanup.txt",
          content: Buffer.from("synthetic request attachment").toString("base64"),
        },
      ],
      { supportsImages: false },
    );
    const [uploaded] = parsed.offloadedRefs;
    assert(uploaded, "request parser did not offload the attachment");
    const deletionEntered = createDeferredCore();
    const releaseDeletion = createDeferredCore();
    const deleteMediaBuffer = mediaStore.deleteMediaBuffer;
    vi.spyOn(mediaStore, "deleteMediaBuffer").mockImplementation(async (id, subdir) => {
      if (id === uploaded.id) {
        deletionEntered.resolve();
        await releaseDeletion.promise;
      }
      await deleteMediaBuffer(id, subdir);
    });
    const drainEntered = createDeferredCore();
    const waitForDrains = await observeMediaDrain(drainEntered);
    const discarded = attachments.discardPreparedInboundMedia(parsed.offloadedRefs);
    await deletionEntered.promise;
    const closing = closeGateway();
    let observedDrain: Promise<void> | undefined;
    try {
      await drainEntered.promise;
      let drained = false;
      observedDrain = waitForDrains().then(() => {
        drained = true;
      });
      // The empty owner resolves in this microtask; a retained deletion cannot.
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(sharedStateLifecycle.has("open")).toBe(true);
      expect(await fs.readFile(uploaded.path, "utf8")).toBe("synthetic request attachment");
    } finally {
      releaseDeletion.resolve();
      await discarded;
      await observedDrain;
      await closing;
    }
    await expect(fs.stat(uploaded.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(sharedStateLifecycle.size).toBe(0);
  });
});
