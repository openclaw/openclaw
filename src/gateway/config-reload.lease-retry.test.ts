import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import * as configJournal from "../config/config-journal-snapshot.js";
import * as configAudit from "../config/io.audit.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import * as pluginLifecycleLease from "../plugins/plugin-lifecycle-lease.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
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
  const releaseChild = createDeferred();
  let workSignal: AbortSignal | undefined;
  const write = makeZeroDebounceHookWrite("scheduler-close");
  const harness = createReloaderHarness(async () => write.snapshot, {
    scheduler,
    onHotReload: async () => {
      workSignal = getAsyncWorkSignal();
      void trackAsyncWork(() => releaseChild.promise);
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
    expect(workSignal).toBeDefined();
    let closed = false;
    closing = scheduler.stop().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    await flushReload(harness.reloader);
    expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
    expect(harness.reloader.isReloading()).toBe(false);
    expect(closed).toBe(false);
    releaseChild.resolve();
    await closing;
    expect(closed).toBe(true);
  } finally {
    release.resolve();
    releaseChild.resolve();
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

it("settles an exhausted admission receipt and retries a later observation with a fresh budget", async () => {
  const withLease = pluginLifecycleLease.withPluginLifecycleLease;
  const acquire = vi
    .spyOn(pluginLifecycleLease, "withPluginLifecycleLease")
    .mockRejectedValue(busyError());
  const write = makeZeroDebounceHookWrite("backoff");
  const application = createRuntimeConfigWriteApplication();
  const settled = vi.fn();
  void application.result.then(settled);
  const harness = createReloaderHarness(async () => write.snapshot);
  await harness.reloader.ready;
  harness.emitWrite(attachRuntimeConfigWriteApplication(write, application));
  await flushReload(harness.reloader);

  for (const delayMs of [250, 500, 1000, 2000, 4000, 5000]) {
    const attempts = acquire.mock.calls.length;
    await flushReload(harness.reloader, delayMs - 1);
    expect(acquire).toHaveBeenCalledTimes(attempts);
    await flushReload(harness.reloader, 1);
    expect(acquire).toHaveBeenCalledTimes(attempts + 1);
    expect(harness.onHotReload).not.toHaveBeenCalled();
  }
  expect(settled).toHaveBeenCalledExactlyOnceWith("failed");
  const exhaustedAttempts = acquire.mock.calls.length;
  await flushReload(harness.reloader, 10_000);
  expect(acquire).toHaveBeenCalledTimes(exhaustedAttempts);
  acquire.mockImplementation(withLease);
  harness.watcher.emit("change");
  await flushReload(harness.reloader);
  expect(harness.onHotReload).toHaveBeenCalledOnce();
  expect(settled).toHaveBeenCalledExactlyOnceWith("failed");

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
  const application = createRuntimeConfigWriteApplication();
  const harness = createReloaderHarness(async () => write.snapshot);
  await harness.reloader.ready;
  harness.emitWrite(attachRuntimeConfigWriteApplication(write, application));
  await flushReload(harness.reloader);
  expect(vi.getTimerCount()).toBe(1);

  await harness.reloader.stop();
  await expect(application.result).resolves.toBe("stopped");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(harness.onHotReload).not.toHaveBeenCalled();
  expect(harness.onConfigApplied).not.toHaveBeenCalled();
  expect(harness.reloader.isReloading()).toBe(false);
  expect(harness.watcher.close).toHaveBeenCalledOnce();
});

const nonRetryableErrors = [
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
];

it.each([
  ...nonRetryableErrors.map((error) => ({ error, entered: false })),
  { error: busyError(), entered: true },
])("does not retry $error after callback entry: $entered", async ({ error, entered }) => {
  const withLease = pluginLifecycleLease.withPluginLifecycleLease;
  const acquire = vi.spyOn(pluginLifecycleLease, "withPluginLifecycleLease");
  if (entered) {
    acquire.mockImplementationOnce((options, run) =>
      withLease(options, async (lease) => {
        await run(lease);
        throw error;
      }),
    );
  } else {
    acquire.mockRejectedValueOnce(error);
  }
  const write = makeZeroDebounceHookWrite("permanent-failure");
  const application = createRuntimeConfigWriteApplication();
  const settled = vi.fn();
  void application.result.then(settled);
  const harness = createReloaderHarness(async () => write.snapshot);
  await harness.reloader.ready;
  harness.emitWrite(attachRuntimeConfigWriteApplication(write, application));
  await flushReload(harness.reloader);
  await flushReload(harness.reloader, 10_000);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(harness.onHotReload).toHaveBeenCalledTimes(entered ? 1 : 0);
  expect(harness.log.error).toHaveBeenCalledWith(`config reload failed: ${String(error)}`);
  expect(settled).toHaveBeenCalledExactlyOnceWith(entered ? "applied" : "failed");
});

it("settles a superseded write while lease admission is still pending", async ({ signal }) => {
  const lease = createDeferred<never>();
  const entered = createDeferred();
  vi.spyOn(pluginLifecycleLease, "withPluginLifecycleLease").mockImplementationOnce(() => {
    entered.resolve();
    return lease.promise;
  });
  const write = makeZeroDebounceHookWrite("superseded");
  const application = createRuntimeConfigWriteApplication();
  const replacement = createRuntimeConfigWriteApplication();
  const harness = createReloaderHarness(async () => write.snapshot);
  await harness.reloader.ready;
  harness.emitWrite(attachRuntimeConfigWriteApplication(write, application));
  await vi.advanceTimersByTimeAsync(0);
  await entered.promise;
  harness.emitWrite(attachRuntimeConfigWriteApplication({ ...write, revision: 2 }, replacement));
  try {
    await expect(withinTest(application.result, signal)).resolves.toBe("superseded");
  } finally {
    lease.reject(new Error("admission failed"));
  }
  await flushReload(harness.reloader);
  await harness.reloader.stop();
  await expect(application.result).resolves.toBe("superseded");
  await expect(replacement.result).resolves.toBe("failed");
});
