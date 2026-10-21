import { execFile } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  onTrustedToolExecutionEvent,
} from "../infra/diagnostic-events.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { PluginHostCleanupResult } from "./host-hook-cleanup.types.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { pluginRuntimeRetentionEntrypoint } from "./runtime-retention-entrypoint.test-support.js";
import { disposePluginRegistryInstances, waitForPluginRegistryRetirement } from "./runtime.js";
import { createPluginRecord } from "./status.test-helpers.js";

const queuedEvent = { type: "message.queued", source: "fixture" } as const;
it.each([
  [onDiagnosticEvent, emitDiagnosticEvent, queuedEvent],
  [onInternalDiagnosticEvent, emitDiagnosticEvent, queuedEvent],
  [onTrustedInternalDiagnosticEvent, emitTrustedDiagnosticEvent, queuedEvent],
  [
    onTrustedToolExecutionEvent,
    emitTrustedDiagnosticEvent,
    {
      type: "tool.execution.started",
      runId: "fixture",
      toolName: "fixture",
      toolCallId: "fixture",
    },
  ],
] as const)(
  "owns %s subscriptions through early unsubscribe and disposal",
  async (subscribe, emit, event) => {
    const instance = new PluginInstance("diagnostic-owner");
    let early = 0;
    let active = 0;
    const unsubscribe = instance.run(() => subscribe(() => early++));
    instance.run(() => subscribe(() => active++));
    const resume = createDeferredCore();
    let late: Promise<() => void> | undefined;
    instance.run(() => {
      late = resume.promise.then(() => subscribe(() => active++));
    });
    emit(event);
    expect([early, active]).toEqual([1, 1]);
    unsubscribe();
    unsubscribe();
    emit(event);
    expect([early, active]).toEqual([1, 2]);
    await instance.dispose();
    resume.resolve();
    await expect(late).rejects.toThrow("retiring");
    emit(event);
    expect([early, active]).toEqual([1, 2]);
  },
);

it.each([
  "diagnostics",
  "loader",
  "registry",
  "registry-instances",
  "cache",
  "formatter",
  "instance",
  "recovery-source",
  "recovery-bundled-cjs",
  "recovery-bundled-mjs",
])(
  "releases retired objects across %s lifetimes",
  async (mode) => {
    await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(pluginRuntimeRetentionEntrypoint)),
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
  const settled = vi.fn();
  let retirement: ReturnType<typeof waitForPluginRegistryRetirement> | undefined;
  try {
    expect(await acknowledged.promise).toEqual({ cleanupCount: 0, failures: [] });
    expect(await waitForPluginRegistryRetirement(registry, { deferConsumers: true })).toEqual({
      cleanupCount: 0,
      failures: [],
      deferredPluginIds: [record.id],
    });
    retirement = waitForPluginRegistryRetirement(registry).finally(settled);
    consumer.release();
    await cleanupEntered.promise;
    await setImmediate();
    expect(settled).not.toHaveBeenCalled();
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
