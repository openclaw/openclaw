import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import * as configJournal from "../config/config-journal-snapshot.js";
import * as configAudit from "../config/io.audit.js";
import { registerRuntimeConfigWriteListener } from "../config/runtime-snapshot.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
  publishRuntimeConfigWrite,
} from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as pluginLifecycleLease from "../plugins/plugin-lifecycle-lease.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import {
  OpenClawStateLeaseAcquisitionError,
  OpenClawStateLeaseError,
} from "../state/openclaw-state-lease-error.js";
import {
  closeTestConfigReloaders,
  createConfigReloadTestClock,
  createReloaderHarness,
  flushReload,
  getOnlyHotReloadCall,
  makeSnapshot,
  makeZeroDebounceHookWrite,
  prepareConfigReloadTest,
  waitForReloadState,
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

function unavailableError(
  reason: "lifecycle-busy" | "sqlite-busy" | "storage-error" = "lifecycle-busy",
) {
  return new OpenClawStateLeaseAcquisitionError("plugin lifecycle lease", {
    kind: "store-unavailable",
    reason,
  });
}

async function readyHarness(
  hash: string,
  options: Parameters<typeof createReloaderHarness>[1] = {},
) {
  const write = makeZeroDebounceHookWrite(hash);
  const harness = createReloaderHarness(async () => write.snapshot, options);
  await harness.reloader.ready;
  const admit = (overrides: Partial<typeof write> = {}) => {
    const application = createRuntimeConfigWriteApplication();
    harness.emitWrite(attachRuntimeConfigWriteApplication({ ...write, ...overrides }, application));
    return application;
  };
  return { ...harness, write, admit };
}

async function admittedWrite(hash: string) {
  const harness = await readyHarness(hash);
  const application = harness.admit();
  const settled = vi.fn();
  void application.result.then(settled);
  return { ...harness, application, settled };
}

it("keeps config observation and application free of main-thread lease reads", async () => {
  const { requireNodeSqlite } = await import("../infra/node-sqlite.js");
  const reads = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  const withLease = pluginLifecycleLease.withPluginLifecycleLease;
  vi.spyOn(pluginLifecycleLease, "withPluginLifecycleLease").mockImplementation((options, run) =>
    withLease(options, (lease) => {
      reads.queries.length = 0;
      return run(lease);
    }),
  );
  const leaseReads = () => reads.queries.filter((sql) => /from "state_leases"/i.test(sql)).length;
  const checkpoints: number[] = [];
  const snapshot = makeZeroDebounceHookWrite("observation-lease").snapshot;
  const harness = createReloaderHarness(
    async () => {
      checkpoints.push(leaseReads());
      return snapshot;
    },
    {
      readPluginInstallRecords: async () => {
        checkpoints.push(leaseReads());
        return {};
      },
    },
  );
  await harness.reloader.ready;
  checkpoints.length = 0;
  harness.watcher.emit("change");
  await flushReload(harness.reloader);

  expect(checkpoints).toEqual([0, 0]);
  expect(harness.onHotReload).toHaveBeenCalledOnce();
  expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
  reads.restore();
});

it("rejects a lease that expires during observation before applying the config", async () => {
  const withLease = pluginLifecycleLease.withPluginLifecycleLease;
  vi.spyOn(pluginLifecycleLease, "withPluginLifecycleLease").mockImplementation((options, run) =>
    withLease({ ...options, leaseMs: 1_000 }, run),
  );
  let expire = false;
  const snapshot = makeZeroDebounceHookWrite("expired-observation").snapshot;
  const readPluginInstallRecords = vi.fn(async () => ({}));
  const harness = createReloaderHarness(
    async () => {
      if (expire) {
        // Acquisition uses the worker's real clock; suspend without running the heartbeat.
        vi.setSystemTime(vi.getRealSystemTime() + 60_000);
      }
      return snapshot;
    },
    { readPluginInstallRecords },
  );
  await harness.reloader.ready;
  readPluginInstallRecords.mockClear();
  expire = true;
  harness.watcher.emit("change");
  await flushReload(harness.reloader);

  expect(readPluginInstallRecords).not.toHaveBeenCalled();
  expect(harness.onHotReload).not.toHaveBeenCalled();
  expect(harness.onConfigAccepted).not.toHaveBeenCalled();
  expect(harness.log.error).toHaveBeenCalledWith(expect.stringContaining("lease"));
});

it("coalesces config writes after a delayed Gateway scheduler wake", async () => {
  const { clock, scheduler } = createConfigReloadTestClock();
  const harness = await readyHarness("delayed-wake", { scheduler });
  harness.emitWrite(harness.write);
  harness.emitWrite({ ...harness.write, revision: 2 });
  await clock.advanceBy(60_000);
  expect(harness.onHotReload).toHaveBeenCalledOnce();
  expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
  await clock.advanceBy(60_000);
  expect(harness.onHotReload).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "settles a canonical reread by whether it preserves the saved change (%s)",
  async (preserved) => {
    const initial = { gateway: { reload: {} }, ui: { prefs: { locale: "en" } } };
    const written = { ...initial, ui: { prefs: { locale: "fr" } } };
    const observed = {
      ...written,
      ui: { prefs: { locale: preserved ? "fr" : "de" } },
      logging: { level: "warn" as const },
    };
    const persistedHash = "canonical-reread";
    const snapshot = makeSnapshot({ config: observed, hash: persistedHash });
    const harness = createReloaderHarness(async () => snapshot, { initialConfig: initial });
    await harness.reloader.ready;
    const application = createRuntimeConfigWriteApplication();
    const unsubscribe = registerRuntimeConfigWriteListener((write) => harness.emitWrite(write));
    try {
      publishRuntimeConfigWrite({
        configPath: snapshot.path,
        snapshot,
        previousSourceConfig: initial,
        writtenSourceConfig: written,
        sourceConfig: observed,
        runtimeConfig: observed,
        persistedHash,
        deferRuntimeActivation: true,
        preparedCandidates: new Map(),
        writeOptions: attachRuntimeConfigWriteApplication({}, application),
      });
      await flushReload(harness.reloader);

      expect(harness.onConfigAccepted.mock.calls[0]?.[0]).toEqual(observed);
      await expect(application.result).resolves.toBe(preserved ? "applied" : "superseded");
    } finally {
      unsubscribe();
    }
  },
);

it("applies an automatic write after the same source was accepted without runtime application", async () => {
  const initialConfig = { gateway: { reload: {} } };
  const harness = await readyHarness("source-only-follow-up", { initialConfig });
  harness.emitWrite({
    ...harness.write,
    afterWrite: { mode: "none", reason: "source owner handles follow-up" },
  });
  await flushReload(harness.reloader);
  expect(harness.onHotReload).not.toHaveBeenCalled();
  expect(harness.onEffectiveConfigUnchanged).not.toHaveBeenCalled();
  expect(harness.onConfigAccepted.mock.calls.at(-1)?.[3]).toEqual({ runtimeApplied: false });

  const application = harness.admit({
    revision: 2,
    preparedCandidate: { runtimeConfig: initialConfig, compareConfig: initialConfig },
  });
  await flushReload(harness.reloader);

  await expect(application.result).resolves.toBe("applied");
  expect(harness.onEffectiveConfigUnchanged).toHaveBeenCalledOnce();
  expect(harness.onConfigAccepted.mock.calls.at(-1)?.[3]).toEqual({
    runtimeApplied: true,
    publishSource: expect.any(Function),
  });
});

it("joins an admitted reload when its Gateway scheduler stops", async () => {
  const { clock, scheduler } = createConfigReloadTestClock();
  const started = createDeferred();
  const release = createDeferred();
  const releaseChild = createDeferred();
  let workSignal: AbortSignal | undefined;
  const harness = await readyHarness("scheduler-close", {
    scheduler,
    onHotReload: async () => {
      workSignal = getAsyncWorkSignal();
      void trackAsyncWork(() => releaseChild.promise);
      started.resolve();
      await release.promise;
      return "applied";
    },
  });
  harness.emitWrite(harness.write);
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
      .mockRejectedValueOnce(unavailableError(reason));
    const harness = await readyHarness("lease-retry");

    if (source === "write") {
      harness.emitWrite(harness.write);
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
    expect(harness.onConfigApplied.mock.calls[0]?.[1]).toEqual(harness.write.runtimeConfig);
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
    .mockRejectedValue(unavailableError());
  const harness = await admittedWrite("backoff");
  const { settled } = harness;
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

  acquire.mockRejectedValueOnce(unavailableError());
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
    .mockRejectedValueOnce(unavailableError());
  const harness = await admittedWrite("shutdown");
  await flushReload(harness.reloader);
  expect(vi.getTimerCount()).toBe(1);

  await harness.reloader.stop();
  await expect(harness.application.result).resolves.toBe("stopped");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(harness.onHotReload).not.toHaveBeenCalled();
  expect(harness.onConfigApplied).not.toHaveBeenCalled();
  expect(harness.reloader.isReloading()).toBe(false);
  expect(harness.watcher.close).toHaveBeenCalledOnce();
});

const nonRetryableErrors = [
  unavailableError("storage-error"),
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
  { error: unavailableError(), entered: true },
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
  const harness = await admittedWrite("permanent-failure");
  const { settled } = harness;
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
  const harness = await admittedWrite("superseded");
  const { application } = harness;
  await vi.advanceTimersByTimeAsync(0);
  await entered.promise;
  const replacement = harness.admit({ revision: 2 });
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

it("applies a leased plugin change while startup reconciles a config edit", async ({ signal }) => {
  vi.useRealTimers();
  const startupConfig: OpenClawConfig = { gateway: { reload: {} } };
  // The file changed after startup read it, so initial reconciliation queues a reload.
  let diskConfig: OpenClawConfig = { ...startupConfig, logging: { level: "debug" } };
  const startupEdit = diskConfig;
  const preparation = createDeferred();
  const runtime = { operationId: "startup-plugin-reload", generation: 9, pluginIds: ["notes"] };
  const harness = createReloaderHarness(
    async () => makeSnapshot({ config: diskConfig, hash: "disk" }),
    {
      initialConfig: startupConfig,
      prepareConfigCandidate: async ({ runtimeConfig, sourceConfig }) => {
        await preparation.promise;
        return { runtimeConfig, compareConfig: sourceConfig };
      },
      onHotReload: async (plan, config, ownership) => {
        ownership.markRuntimeCommitted(config, plan);
        return { status: "applied", runtime };
      },
    },
  );
  const startWatcher = harness.watcher.adapter.start.getMockImplementation();
  harness.watcher.adapter.start.mockImplementationOnce(async () => {
    await startWatcher?.();
    harness.watcher.emit("ready");
  });
  try {
    // plugins.reload holds the lease before startup reaches its watcher drain.
    await pluginLifecycleLease.withPluginLifecycleLease({}, async () => {
      const application = harness.reloader.applyPluginLifecycleChange({
        config: startupEdit,
        pluginIds: ["notes"],
        reason: "reload",
      });
      preparation.resolve();
      await expect(withinTest(application, signal)).resolves.toEqual(runtime);
    });
    await withinTest(harness.reloader.ready, signal);
    await waitForReloadState(() => !harness.reloader.isReloading());

    // The application carried the startup edit; the queued reload sees only its echo.
    const [plan, appliedConfig] = getOnlyHotReloadCall(harness);
    expect(plan.pluginLifecycle?.pluginIds).toEqual(["notes"]);
    expect(plan.changedPaths).toEqual(["logging"]);
    expect(appliedConfig).toEqual(startupEdit);

    // The watcher still owns later edits once the startup drain completes.
    diskConfig = { ...startupConfig, logging: { level: "warn" } };
    harness.watcher.emit("change");
    await waitForReloadState(() =>
      harness.onConfigAccepted.mock.calls.some(([config]) => config.logging?.level === "warn"),
    );
  } finally {
    preparation.resolve();
    await harness.reloader.stop();
  }
});
