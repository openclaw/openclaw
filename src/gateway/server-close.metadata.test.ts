import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { getPluginValueInstance } from "../plugins/plugin-instance-scope.js";
import { PluginRuntimeCloseRetainedError } from "../plugins/runtime-close-error.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { getGatewayContextLifetime } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { getActiveSecretsRuntimeSnapshotState } from "../secrets/runtime-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { loadGatewayPlugins } from "./server-plugins.js";

async function createFixture() {
  const fixture = await createGatewayMetadataCloseFixture("metadata-close");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const onClose: Array<() => void | Promise<void>> = [];
  let closing: Promise<void> | undefined;
  const dispose = async () => {
    release.resolve();
    await Promise.allSettled([closing]);
    try {
      for (const cleanup of onClose) {
        await cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  };
  try {
    const { server, kernel } = await fixture.startServer();
    return {
      ...fixture,
      kernel,
      entered,
      release,
      onClose,
      close: (reason: string) => (closing = server.close({ reason })),
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function setupOwner(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const metadata = fixture.kernel.getPluginMetadataSnapshot();
  assert(metadata);
  const callback = fixture.loadCallback(metadata);
  const owner = getPluginValueInstance(callback);
  assert(owner);
  return { callback, owner };
}

it("retires retained Gateway bindings after metadata close fails", async () => {
  await using fixture = await createFixture();
  const { kernel, entered, release } = fixture;
  const failure = new PluginRuntimeCloseRetainedError(new Error("metadata close refused"));
  let loaded: Awaited<ReturnType<typeof loadGatewayPlugins>> | undefined;
  fixture.onClose.push(async () => {
    loaded?.retireGatewayRuntimeBindings();
    if (loaded) {
      await disposePluginRegistryInstances(loaded.pluginRegistry);
    }
  });
  let available: PluginRuntime["gateway"]["isAvailable"] | undefined;
  const loader = await import("../plugins/loader.js");
  const load = loader.loadOpenClawPluginsAsync;
  const observed = vi.spyOn(loader, "loadOpenClawPluginsAsync").mockImplementation((options) => {
    available = options?.runtimeOptions?.gateway?.isAvailable;
    return load(options);
  });
  try {
    loaded = await loadGatewayPlugins({
      cfg: kernel.cfgAtStart,
      autoEnabledReasons: {},
      baseMethods: [],
      pluginIds: [fixture.pluginId],
      pluginMetadataSnapshot: kernel.getPluginMetadataSnapshot(),
      resolveGatewayContext: kernel.resolvePluginGatewayContext,
      loadIntent: "startup",
      env: fixture.state.env,
    });
  } finally {
    observed.mockRestore();
  }
  assert(available);
  expect(loaded.pluginRegistry.plugins).toContainEqual(
    expect.objectContaining({ id: fixture.pluginId, status: "loaded" }),
  );
  await expect(available()).resolves.toBe(true);
  const close = kernel.kernel.pluginMetadata.close.bind(kernel.kernel.pluginMetadata);
  const held = vi
    .spyOn(kernel.kernel.pluginMetadata, "close")
    .mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      await close(...args);
      throw failure;
    });
  fixture.onClose.unshift(() => held.mockRestore());
  const closing = fixture.close("retire bound context").catch((error: unknown) => error);
  await awaitGateBeforeSettlement(entered.promise, closing, "metadata close not reached");
  await expect(available()).resolves.toBe(true);
  release.resolve();
  expect(collectNestedErrorCandidates(await closing)).toContain(failure);
  await expect(available()).resolves.toBe(false);
  expect(getGatewayContextLifetime(kernel.resolvePluginGatewayContext).signal.aborted).toBe(true);
});

it("joins managed setup cleanup before releasing shared state and secrets", async () => {
  await using fixture = await createFixture();
  const { kernel, entered, release } = fixture;
  const { owner } = setupOwner(fixture);
  const database = openOpenClawStateDatabase({ env: fixture.state.env }).db;
  assert(getActiveSecretsRuntimeSnapshotState());
  owner.lifecycle.onDispose(async () => {
    entered.resolve();
    await release.promise;
  });
  let settled = false;
  const closing = fixture.close("join setup cleanup").then(() => {
    settled = true;
  });
  await awaitGateBeforeSettlement(
    entered.promise,
    closing,
    "Gateway closed without joining its setup owner",
  );
  await nextTurn();
  expect(settled).toBe(false);
  expect(database.isOpen).toBe(true);
  expect(getActiveSecretsRuntimeSnapshotState()).not.toBeNull();
  expect(getGatewayContextLifetime(kernel.resolvePluginGatewayContext).signal.aborted).toBe(false);
  release.resolve();
  await closing;
  expect(database.isOpen).toBe(false);
  expect(getActiveSecretsRuntimeSnapshotState()).toBeNull();
  expect(owner.lifecycle.signal.aborted).toBe(true);
  expect(process.listenerCount(fixture.event)).toBe(fixture.listeners);
});

it("refuses a new Gateway until the final shared-state reset finishes", async () => {
  await using fixture = await createFixture();
  const { entered, release } = fixture;
  const { callback, owner } = setupOwner(fixture);
  const reset = resolveGlobalSingleton(
    Symbol("metadata-reset"),
    () => ({ enabled: true }),
    async (state) => {
      if (state.enabled) {
        entered.resolve();
        await release.promise;
      }
    },
    "close-only",
  );
  fixture.onClose.push(() => {
    reset.enabled = false;
  });
  const closing = fixture.close("hold final shared reset");
  await awaitGateBeforeSettlement(
    entered.promise,
    closing,
    "Gateway closed without entering the final shared reset",
  );
  expect(owner.lifecycle.signal.aborted).toBe(true);
  expect(() => callback()).toThrow("reloaded or disabled");
  const attempted = await fixture.start(await fixture.reservePort()).then(
    (admitted) => ({ admitted }),
    (error: unknown) => ({ error }),
  );
  expect(attempted).toEqual({ error: expect.any(Error) });
  release.resolve();
  await closing;
  reset.enabled = false;
  const { server: successor, kernel } = await fixture.startServer();
  const metadata = kernel.getPluginMetadataSnapshot();
  assert(metadata);
  await expect(fixture.loadCallback(metadata)()).resolves.toBe("captured");
  expect(getActiveSecretsRuntimeSnapshotState()).not.toBeNull();
  await successor.close({ reason: "final reset successor proved usable" });
});
