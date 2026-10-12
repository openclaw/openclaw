import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi } from "vitest";
import { getPluginValueInstance } from "../plugins/plugin-instance-scope.js";
import { PluginRuntimeCloseRetainedError } from "../plugins/runtime-close-error.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { getGatewayContextLifetime } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { getActiveSecretsRuntimeSnapshotState } from "../secrets/runtime-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createGatewayMetadataCloseFixture as createFixture } from "./server-close.metadata.test-support.js";
import { loadGatewayPlugins } from "./server-plugins.js";

it("retires retained Gateway bindings after metadata close fails", async () => {
  const fixture = await createFixture("gateway-context-close-failure");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const failure = new PluginRuntimeCloseRetainedError(new Error("metadata close refused"));
  let loaded: ReturnType<typeof loadGatewayPlugins> | undefined;
  let closing: Promise<unknown> | undefined;
  let restoreClose: (() => void) | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    let available: PluginRuntime["gateway"]["isAvailable"] | undefined;
    const loader = await import("../plugins/loader.js");
    const load = loader.loadOpenClawPlugins;
    const observed = vi.spyOn(loader, "loadOpenClawPlugins").mockImplementation((options) => {
      available = options?.runtimeOptions?.gateway?.isAvailable;
      return load(options);
    });
    try {
      loaded = loadGatewayPlugins({
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
    expect(loaded.pluginRegistry.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: fixture.pluginId, status: "loaded" })]),
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
    restoreClose = () => held.mockRestore();
    closing = server.close({ reason: "retire bound context" }).catch((error: unknown) => error);
    await Promise.race([
      entered.promise,
      closing.then(() => {
        throw new Error("metadata close not reached");
      }),
    ]);
    await expect(available()).resolves.toBe(true);
    release.resolve();
    const result = await closing;
    expect(collectNestedErrorCandidates(result)).toContain(failure);
    await expect(available()).resolves.toBe(false);
    expect(getGatewayContextLifetime(kernel.resolvePluginGatewayContext).signal.aborted).toBe(true);
  } finally {
    release.resolve();
    await closing;
    restoreClose?.();
    loaded?.retireGatewayRuntimeBindings();
    if (loaded) {
      await disposePluginRegistryInstances(loaded.pluginRegistry);
    }
    await fixture.cleanup();
  }
});

it("joins managed setup cleanup before releasing shared state and secrets", async () => {
  const fixture = await createFixture("gateway-metadata-held-close");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let closing: Promise<void> | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const metadata = kernel.getPluginMetadataSnapshot();
    assert(metadata);
    const callback = fixture.loadCallback(metadata);
    const owner = getPluginValueInstance(callback);
    assert(owner);
    const database = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    assert(getActiveSecretsRuntimeSnapshotState());
    owner.lifecycle.onDispose(async () => {
      entered.resolve();
      await release.promise;
    });
    let settled = false;
    closing = server.close({ reason: "join setup cleanup" }).then(() => {
      settled = true;
    });
    await Promise.race([
      entered.promise,
      closing.then(() => {
        throw new Error("Gateway closed without joining its setup owner");
      }),
    ]);
    await nextTurn();
    expect(settled).toBe(false);
    expect(database.isOpen).toBe(true);
    expect(getActiveSecretsRuntimeSnapshotState()).not.toBeNull();
    expect(getGatewayContextLifetime(kernel.resolvePluginGatewayContext).signal.aborted).toBe(
      false,
    );
    release.resolve();
    await closing;
    expect(database.isOpen).toBe(false);
    expect(getActiveSecretsRuntimeSnapshotState()).toBeNull();
    expect(owner.lifecycle.signal.aborted).toBe(true);
    expect(process.listenerCount(fixture.event)).toBe(fixture.listeners);
  } finally {
    release.resolve();
    await Promise.allSettled([closing]);
    await fixture.cleanup();
  }
});

it("refuses a new Gateway until the final shared-state reset finishes", async () => {
  const fixture = await createFixture("gateway-metadata-final-reset");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let closing: Promise<void> | undefined;
  let reset: { enabled: boolean } | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const metadata = kernel.getPluginMetadataSnapshot();
    assert(metadata);
    const callback = fixture.loadCallback(metadata);
    const setupOwner = getPluginValueInstance(callback);
    assert(setupOwner);
    reset = resolveGlobalSingleton(
      Symbol("gateway-metadata-final-reset-fixture"),
      () => ({ enabled: true }),
      async (state) => {
        if (state.enabled) {
          entered.resolve();
          await release.promise;
        }
      },
      "close-only",
    );
    closing = server.close({ reason: "hold final shared reset" });
    await Promise.race([
      entered.promise,
      closing.then(() => {
        throw new Error("Gateway closed without entering the final shared reset");
      }),
    ]);
    expect(setupOwner.lifecycle.signal.aborted).toBe(true);
    expect(() => callback()).toThrow("reloaded or disabled");
    const attempted = await fixture.start(await fixture.reservePort()).then(
      (admitted) => ({ admitted }),
      (error: unknown) => ({ error }),
    );
    expect(attempted).toEqual({ error: expect.any(Error) });
    release.resolve();
    await closing;
    reset.enabled = false;
    const nextPort = await fixture.reservePort();
    const successor = await fixture.start(nextPort);
    const next = fixture.kernels.get(nextPort);
    assert(next);
    const nextMetadata = next.getPluginMetadataSnapshot();
    assert(nextMetadata);
    await expect(fixture.loadCallback(nextMetadata)()).resolves.toBe("captured");
    expect(getActiveSecretsRuntimeSnapshotState()).not.toBeNull();
    await successor.close({ reason: "final reset successor proved usable" });
  } finally {
    release.resolve();
    await Promise.allSettled([closing]);
    if (reset) {
      reset.enabled = false;
    }
    // The pre-fix path may have admitted a server; the fixture owns it as well.
    await fixture.cleanup();
  }
});
