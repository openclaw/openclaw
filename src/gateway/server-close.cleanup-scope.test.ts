import "./server-worker-free.test-support.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { retainGatewayPluginMetadata } from "../plugins/plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getPluginLoaderCacheState } from "../plugins/registry-lifecycle.js";
import {
  createPluginRegistryOwner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { completeGatewayClose, prepareGatewayClose } from "./server-close.js";
import { createGatewayCloseTestDepsFactory } from "./server-close.test-support.js";
import { GatewayConnectionWork } from "./server-connection-work.js";

const mocks = vi.hoisted(() => ({
  closePluginStateDatabaseAsync: vi.fn(async () => {}),
}));
vi.mock("../plugin-state/plugin-state-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-state/plugin-state-store.js")>()),
  closePluginStateDatabaseAsync: mocks.closePluginStateDatabaseAsync,
}));

const createGatewayCloseTestDeps = createGatewayCloseTestDepsFactory({
  disposeAllBundleLspRuntimes: async () => {},
  stopGmailWatcher: async () => {},
  disposeAllCodeModeRuns: async () => {},
  closeProviderTransportDispatcherPool: async () => {},
  drainRetainedEmbeddingProviders: async () => {},
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

it("owns plugin cleanup and its descendants after the requesting connection drains", async () => {
  const connectionWork = new GatewayConnectionWork();
  const requestContext = connectionWork.run(() => AsyncLocalStorage.snapshot());
  await connectionWork.drain();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const completed = vi.fn();
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "drain-cleanup", status: "loaded" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  const cleanup = vi.fn(async () => {
    await trackAsyncWork(async () => {});
    void trackAsyncWork(async () => {
      entered.resolve();
      await release.promise;
      expect(mocks.closePluginStateDatabaseAsync).not.toHaveBeenCalled();
      completed();
    });
  });
  registry.runtimeLifecycles.push({
    pluginId: record.id,
    pluginName: record.name,
    source: "drain-cleanup-fixture",
    lifecycle: { id: "async-cleanup", cleanup },
  });
  const metadata = retainGatewayPluginMetadata();
  getPluginLoaderCacheState().set("drain-cleanup", registry);
  const servingRegistry = createEmptyPluginRegistry();
  setActivePluginRegistry(servingRegistry);
  const owner = createPluginRegistryOwner(servingRegistry);
  const params = createGatewayCloseTestDeps({
    closePluginRegistry: owner.close,
    pluginMetadata: metadata,
  });
  const closing = requestContext(async () =>
    completeGatewayClose(
      params,
      await prepareGatewayClose(params, { restartExpectedMs: 0, drainTimeoutMs: 0 }),
    ),
  );
  try {
    await Promise.race([entered.promise, closing]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(mocks.closePluginStateDatabaseAsync).not.toHaveBeenCalled();
    release.resolve();
    await expect(closing).resolves.toMatchObject({ warnings: [] });
    expect(instance.lifecycle.signal.aborted).toBe(true);
    expect(completed).toHaveBeenCalledOnce();
    expect(mocks.closePluginStateDatabaseAsync).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await closing.catch(() => {});
  }
});
