import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as configJournal from "../config/config-journal-snapshot.js";
import * as configAudit from "../config/io.audit.js";
import * as pluginLifecycleLease from "../plugins/plugin-lifecycle-lease.js";
import {
  OpenClawStateLeaseAcquisitionError,
  OpenClawStateLeaseError,
} from "../state/openclaw-state-lease-error.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  closeTestConfigReloaders,
  createReloaderHarness,
  flushReload,
  makeZeroDebounceHookWrite,
  prepareConfigReloadTest,
} from "./config-reload.test-support.js";

beforeEach((context) => {
  prepareConfigReloadTest(context);
  vi.useFakeTimers();
  vi.spyOn(configAudit, "appendConfigAuditRecord").mockResolvedValue(undefined);
  vi.spyOn(configJournal, "readLatestConfigSnapshotAuditRecordAsync").mockResolvedValue(null);
  vi.spyOn(configJournal, "upsertConfigSnapshotAuditRecordAsync").mockResolvedValue(null);
});

afterEach(async () => {
  await closeTestConfigReloaders();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function busyError(reason: "lifecycle-busy" | "sqlite-busy" = "lifecycle-busy") {
  return new OpenClawStateLeaseAcquisitionError("plugin lifecycle lease", {
    kind: "store-unavailable",
    reason,
  });
}

it("coalesces config writes after a delayed Gateway scheduler wake", async () => {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const write = makeZeroDebounceHookWrite("delayed-wake");
  const harness = createReloaderHarness(async () => write.snapshot, { scheduler });
  try {
    await harness.reloader.ready;
    harness.emitWrite(write);
    harness.emitWrite({ ...write, revision: 2 });
    await clock.advanceBy(60_000);
    expect(harness.onHotReload).toHaveBeenCalledOnce();
    expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
    await clock.advanceBy(60_000);
    expect(harness.onHotReload).toHaveBeenCalledOnce();
  } finally {
    await harness.reloader.stop();
    await scheduler.stop();
  }
});

it("joins an admitted reload when its Gateway scheduler stops", async () => {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const started = createDeferred();
  const release = createDeferred();
  const write = makeZeroDebounceHookWrite("scheduler-close");
  const harness = createReloaderHarness(async () => write.snapshot, {
    scheduler,
    onHotReload: async () => {
      started.resolve();
      await release.promise;
      return "applied";
    },
  });
  await harness.reloader.ready;
  harness.emitWrite(write);
  const waking = clock.advanceBy(0);
  let closing: Promise<void> | undefined;
  try {
    await started.promise;
    let closed = false;
    closing = scheduler.stop().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    await closing;
    expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await Promise.all([waking, closing]);
    await harness.reloader.stop();
    await scheduler.stop();
  }
});

it.each([
  { source: "file", reason: "lifecycle-busy" },
  { source: "file", reason: "sqlite-busy" },
  { source: "write", reason: "lifecycle-busy" },
] as const)(
  "retries $source reload after $reason without another event",
  async ({ source, reason }) => {
    const acquire = vi
      .spyOn(pluginLifecycleLease, "withPluginLifecycleLease")
      .mockRejectedValueOnce(busyError(reason));
    const write = makeZeroDebounceHookWrite("lease-retry");
    const harness = createReloaderHarness(async () => write.snapshot);
    await harness.reloader.ready;

    if (source === "write") {
      harness.emitWrite(write);
    } else {
      harness.watcher.emit("change");
    }
    await flushReload(harness.reloader);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(harness.onHotReload).not.toHaveBeenCalled();
    expect(harness.onConfigAccepted).not.toHaveBeenCalled();

    await flushReload(harness.reloader, 250);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(harness.onHotReload).toHaveBeenCalledOnce();
    expect(harness.onConfigApplied.mock.calls[0]?.[1]).toEqual(write.runtimeConfig);
    expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
    expect(harness.log.error).not.toHaveBeenCalled();
    await flushReload(harness.reloader, 10_000);
    expect(acquire).toHaveBeenCalledTimes(2);
  },
);

it("bounds repeated admission backoff and resets it after an admitted reload", async () => {
  const withLease = pluginLifecycleLease.withPluginLifecycleLease;
  const acquire = vi
    .spyOn(pluginLifecycleLease, "withPluginLifecycleLease")
    .mockRejectedValue(busyError());
  const write = makeZeroDebounceHookWrite("backoff");
  const harness = createReloaderHarness(async () => write.snapshot);
  await harness.reloader.ready;
  harness.watcher.emit("change");
  await flushReload(harness.reloader);

  for (const delayMs of [250, 500, 1000, 2000, 4000, 5000, 5000]) {
    const attempts = acquire.mock.calls.length;
    await flushReload(harness.reloader, delayMs - 1);
    expect(acquire).toHaveBeenCalledTimes(attempts);
    await flushReload(harness.reloader, 1);
    expect(acquire).toHaveBeenCalledTimes(attempts + 1);
    expect(harness.onHotReload).not.toHaveBeenCalled();
  }
  acquire.mockImplementation(withLease);
  await flushReload(harness.reloader, 5000);
  expect(harness.onHotReload).toHaveBeenCalledOnce();

  acquire.mockRejectedValueOnce(busyError());
  harness.watcher.emit("change");
  await flushReload(harness.reloader);
  const attempts = acquire.mock.calls.length;
  await flushReload(harness.reloader, 250);
  expect(acquire).toHaveBeenCalledTimes(attempts + 1);
  expect(harness.onConfigAccepted).toHaveBeenCalledTimes(2);
});

it("cancels a pending admission retry on shutdown without applying or leaking timers", async () => {
  const acquire = vi
    .spyOn(pluginLifecycleLease, "withPluginLifecycleLease")
    .mockRejectedValueOnce(busyError());
  const write = makeZeroDebounceHookWrite("shutdown");
  const harness = createReloaderHarness(async () => write.snapshot);
  await harness.reloader.ready;
  harness.watcher.emit("change");
  await flushReload(harness.reloader);
  expect(vi.getTimerCount()).toBe(1);

  await harness.reloader.stop();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(harness.onHotReload).not.toHaveBeenCalled();
  expect(harness.onConfigApplied).not.toHaveBeenCalled();
  expect(harness.reloader.isReloading()).toBe(false);
  expect(harness.watcher.close).toHaveBeenCalledOnce();
});

it.each([
  new OpenClawStateLeaseAcquisitionError("plugin lifecycle lease", {
    kind: "store-unavailable",
    reason: "storage-error",
  }),
  new OpenClawStateLeaseAcquisitionError("plugin lifecycle lease", {
    kind: "aborted",
    reason: "caller-signal",
    elapsedMs: 0,
  }),
  new OpenClawStateLeaseError("lease lost", { code: "OPENCLAW_STATE_LEASE_LOST" }),
  new Error("store unavailable (lifecycle-busy)"),
])("keeps non-retryable admission failures visible: %s", async (error) => {
  const acquire = vi
    .spyOn(pluginLifecycleLease, "withPluginLifecycleLease")
    .mockRejectedValueOnce(error);
  const write = makeZeroDebounceHookWrite("permanent-failure");
  const harness = createReloaderHarness(async () => write.snapshot);
  await harness.reloader.ready;
  harness.watcher.emit("change");
  await flushReload(harness.reloader);
  await flushReload(harness.reloader, 10_000);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(harness.log.error).toHaveBeenCalledWith(`config reload failed: ${String(error)}`);
  expect(harness.onHotReload).not.toHaveBeenCalled();
});

it("does not retry an acquisition error propagated after reload callback entry", async () => {
  const withLease = pluginLifecycleLease.withPluginLifecycleLease;
  const error = busyError();
  const acquire = vi
    .spyOn(pluginLifecycleLease, "withPluginLifecycleLease")
    .mockImplementationOnce((options, run) =>
      withLease(options, async (lease) => {
        await run(lease);
        throw error;
      }),
    );
  const write = makeZeroDebounceHookWrite("post-entry-failure");
  const harness = createReloaderHarness(async () => write.snapshot);
  await harness.reloader.ready;
  harness.watcher.emit("change");
  await flushReload(harness.reloader);
  await flushReload(harness.reloader, 10_000);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(harness.onHotReload).toHaveBeenCalledOnce();
  expect(harness.log.error).toHaveBeenCalledWith(`config reload failed: ${String(error)}`);
});
