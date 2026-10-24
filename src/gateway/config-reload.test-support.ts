import { AsyncLocalStorage } from "node:async_hooks";
import { assert, expect, it, onTestFinished, vi, type TestContext } from "vitest";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTestConfigSnapshot } from "../commands/test-runtime-config-helpers.js";
import type {
  ConfigFileSnapshot,
  ConfigWriteNotification,
  OpenClawConfig,
} from "../config/config.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import * as backoff from "../infra/backoff.js";
import * as pluginLifecycleLease from "../plugins/plugin-lifecycle-lease.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  startGatewayConfigReloader as startGatewayConfigReloaderImpl,
  type GatewayConfigReloadTransactionOwnership,
  type GatewayReloadPlan,
} from "./config-reload.js";
import { installWatcherMock } from "./config-reload.watcher.test-support.js";

type Reloader = ReturnType<typeof startGatewayConfigReloaderImpl>;
type ReloadOptions = Parameters<typeof startGatewayConfigReloaderImpl>[0];
const activeReloaders = new Set<Reloader>();
let currentTest: { timeout: number; signal: AbortSignal } | undefined;

function mockCallback<F extends (...args: never[]) => unknown>(
  callback: F | undefined,
  fallback: NoInfer<F>,
) {
  return vi.fn<F>(callback ?? fallback);
}

export function prepareConfigReloadTest(
  { task, signal }: TestContext,
  options: { mockWatcher?: boolean } = {},
) {
  currentTest = { timeout: task.timeout, signal };
  if (options.mockWatcher) {
    const watcher = installWatcherMock();
    onTestFinished(() => watcher.restore());
  }
}

export function createConfigReloadTestClock() {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  onTestFinished(() => scheduler.stop());
  return { clock, scheduler };
}

export function createPluginLifecycleLeaseTestClock() {
  const leaseScope = new AsyncLocalStorage<boolean>();
  const pendingBackoffs = new Set<{ dueAt: number }>();
  let backoffScheduled = createDeferred();
  const sleep = backoff.sleepWithAbort;
  const sleepSpy = vi.spyOn(backoff, "sleepWithAbort").mockImplementation((ms, ...args) => {
    const completion = sleep(ms, ...args);
    if (leaseScope.getStore() && Number.isFinite(ms) && ms > 0) {
      const pending = { dueAt: Date.now() + Math.max(1, Math.floor(ms)) };
      pendingBackoffs.add(pending);
      const scheduled = backoffScheduled;
      backoffScheduled = createDeferred();
      scheduled.resolve();
      void completion.then(
        () => pendingBackoffs.delete(pending),
        () => pendingBackoffs.delete(pending),
      );
    }
    return completion;
  });
  const withLease = pluginLifecycleLease.withPluginLifecycleLease;
  const withCleanupLease = pluginLifecycleLease.withPluginArtifactCleanupLease;
  let firstCompletion: Promise<unknown> | undefined;
  const trackLease = <T>(start: () => Promise<T>): Promise<T> => {
    const completion = leaseScope.run(true, start);
    firstCompletion ??= completion;
    return completion;
  };
  const leaseSpy = vi
    .spyOn(pluginLifecycleLease, "withPluginLifecycleLease")
    .mockImplementation((options, run) => trackLease(() => withLease(options, run)));
  const cleanupLeaseSpy = vi
    .spyOn(pluginLifecycleLease, "withPluginArtifactCleanupLease")
    .mockImplementation((options, run) => trackLease(() => withCleanupLease(options, run)));
  onTestFinished(() => {
    leaseSpy.mockRestore();
    cleanupLeaseSpy.mockRestore();
    sleepSpy.mockRestore();
  });
  const waitFor = async <T>(completion: Promise<T>): Promise<T> => {
    const settlement = completion.then(
      () => "settled",
      () => "settled",
    );
    for (;;) {
      const backoffReady =
        pendingBackoffs.size > 0
          ? Promise.resolve("backoff")
          : backoffScheduled.promise.then(() => "backoff");
      if ((await Promise.race([settlement, backoffReady])) === "settled") {
        return await completion;
      }
      // Worker replies can schedule lease backoff after a fake timer advance ends.
      // Advance only for an observed lease delay; never poll a real clock for completion.
      const next = Math.min(...[...pendingBackoffs].map(({ dueAt }) => dueAt));
      if (Number.isFinite(next)) {
        await vi.advanceTimersByTimeAsync(Math.max(0, next - Date.now()));
      }
    }
  };
  return {
    waitFor,
    async waitForFirstLease() {
      assert.isDefined(firstCompletion);
      await waitFor(firstCompletion);
    },
  };
}

export function createReloadWarningObserver() {
  let record: ((message: string) => void) | undefined;
  return {
    observe: (message: string) => record?.(message),
    next: (text: string) =>
      new Promise<void>((resolve) => {
        record = (message) => {
          if (message.includes(text)) {
            record = undefined;
            resolve();
          }
        };
      }),
  };
}

export function createRecoveryRestartMock() {
  const emitted = createDeferred();
  const requestRecoveryRestart = vi.fn(() => {
    emitted.resolve();
    return { status: "emitted" as const };
  });
  return { requestRecoveryRestart, restartEmitted: emitted.promise };
}

export function startGatewayConfigReloader({
  scheduler = createTestGatewayScheduler("fake-timers"),
  ...opts
}: Omit<ReloadOptions, "scheduler"> & {
  scheduler?: ReloadOptions["scheduler"];
}) {
  const reloader = startGatewayConfigReloaderImpl({ ...opts, scheduler });
  activeReloaders.add(reloader);
  return reloader;
}

export async function closeTestConfigReloaders() {
  const results = await Promise.allSettled(
    [...activeReloaders].map(async (reloader) => {
      await reloader.stop();
      activeReloaders.delete(reloader);
    }),
  );
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Config reloader fixture cleanup failed");
  }
}

export async function waitForReloadState(isSettled: () => boolean) {
  if (!currentTest) {
    throw new Error("Config reload observation requires its current test deadline");
  }
  const { timeout, signal } = currentTest;
  await vi.waitUntil(
    () => {
      signal.throwIfAborted();
      return isSettled();
    },
    { interval: 0, timeout },
  );
}

export async function flushReload(reloader: Pick<Reloader, "isReloading">, delayMs = 0) {
  await vi.advanceTimersByTimeAsync(delayMs);
  await waitForReloadState(() => !reloader.isReloading());
}

export function makeGatewayPortConfig(port: number): OpenClawConfig {
  return { gateway: { reload: {}, port } };
}

export async function ownedConfigReloadOptions(snapshot: ConfigFileSnapshot, configPath: string) {
  const { registerConfigWriteListener } = await import("../config/io.runtime.js");
  return {
    scheduler: createTestGatewayScheduler("fake-timers"),
    initialConfig: snapshot.config,
    initialCompareConfig: snapshot.sourceConfig ?? snapshot.config,
    initialSnapshotRawHash: snapshot.hash ?? null,
    initialAuthoredConfig: snapshot.parsed,
    initialSnapshotValid: snapshot.valid,
    initialSnapshotIssues: snapshot.issues,
    testDebounceMs: 0,
    watchPath: configPath,
    initialPluginInstallRecords: {},
    readPluginInstallRecords: async () => ({}),
    subscribeToWrites: (listener: (event: ConfigWriteNotification) => void) =>
      registerConfigWriteListener(listener, {
        ownsRuntimeActivationFor: configPath,
        preCommitRuntimePreflight: async (config) => ({
          runtimeConfig: config,
          compareConfig: config,
        }),
      }),
  };
}

export function makeSnapshot(partial: Partial<ConfigFileSnapshot> = {}): ConfigFileSnapshot {
  const config = partial.config ?? {};
  const sourceConfig = (partial.sourceConfig ??
    partial.config ??
    {}) as ConfigFileSnapshot["sourceConfig"];
  const runtimeConfig = partial.runtimeConfig ?? partial.config ?? {};
  const parsed = partial.parsed ?? sourceConfig;
  return {
    ...createTestConfigSnapshot(sourceConfig, runtimeConfig),
    includedPaths: [],
    raw: partial.exists === false ? null : JSON.stringify(parsed),
    parsed,
    config,
    ...partial,
  };
}

export function makeZeroDebounceHookSnapshot(hash: string): ConfigFileSnapshot {
  const config = () => ({ gateway: { reload: {} }, hooks: { enabled: true } });
  return makeSnapshot({ config: config(), sourceConfig: config(), runtimeConfig: config(), hash });
}

export function makeZeroDebounceHookWrite(persistedHash: string): ConfigWriteNotification {
  const snapshot = makeZeroDebounceHookSnapshot(persistedHash);
  return {
    configPath: snapshot.path,
    snapshot,
    sourceConfig: snapshot.sourceConfig,
    runtimeConfig: snapshot.runtimeConfig,
    persistedHash,
    revision: 1,
    fingerprint: `runtime-${persistedHash}`,
    sourceFingerprint: `source-${persistedHash}`,
  };
}

export function makeWrite(
  config: OpenClawConfig,
  hash: string,
  overrides: Partial<ConfigWriteNotification> = {},
): ConfigWriteNotification {
  return {
    ...makeZeroDebounceHookWrite(hash),
    sourceConfig: config,
    runtimeConfig: config,
    snapshot: makeSnapshot({ config, hash }),
    ...overrides,
  };
}

export function createReloaderHarness(
  readSnapshot: () => Promise<ConfigFileSnapshot>,
  options: Partial<
    Omit<
      ReloadOptions,
      | "readSnapshot"
      | "log"
      | "subscribeToWrites"
      | "watchPath"
      | "testDebounceMs"
      | "onReloadEnabledChange"
      | "onRuntimeConfigCommitted"
      | "hasOutstandingGatewayRestart"
      | "onConfigCandidateCommitted"
      | "onWatcherReady"
    >
  > = {},
) {
  const watcher = installWatcherMock();
  const callbacks = {
    onConfigChange: mockCallback(options.onConfigChange, async () => {}),
    onConfigApplied: mockCallback(options.onConfigApplied, async () => {}),
    onConfigAccepted: mockCallback(options.onConfigAccepted, async () => {}),
    onConfigRevisionApplied: mockCallback(options.onConfigRevisionApplied, () => {}),
    onReloadEnabledChange: vi.fn<(enabled: boolean) => void>(),
    onEffectiveConfigUnchanged: mockCallback(options.onEffectiveConfigUnchanged, async () => ({
      rollback: async () => {},
    })),
    onNoopConfigCommit: mockCallback(options.onNoopConfigCommit, async () => {}),
    onHotReload: mockCallback(options.onHotReload, async () => "applied"),
    onRestart: mockCallback(options.onRestart, () => {}),
    onConfigCandidateCommitted: vi.fn<NonNullable<ReloadOptions["onConfigCandidateCommitted"]>>(),
  };
  let writeListener: ((event: ConfigWriteNotification) => void) | null = null;
  const subscribeToWrites = vi.fn((listener: (event: ConfigWriteNotification) => void) => {
    writeListener = listener;
    return () => {
      if (writeListener === listener) {
        writeListener = null;
      }
    };
  });
  const log = createInfoWarnErrorLogger();
  const initialConfig = options.initialConfig ?? { gateway: { reload: {} } };
  const reloader = startGatewayConfigReloader({
    ...options,
    ...callbacks,
    testDebounceMs: 0,
    initialConfig,
    initialSnapshotRawHash:
      options.initialSnapshotRawHash === undefined
        ? hashConfigRaw(JSON.stringify(options.initialAuthoredConfig ?? initialConfig))
        : options.initialSnapshotRawHash,
    initialAuthoredConfig: options.initialAuthoredConfig ?? initialConfig,
    initialSnapshotValid: options.initialSnapshotValid ?? true,
    initialSnapshotIssues: options.initialSnapshotIssues ?? [],
    readSnapshot,
    initialPluginInstallRecords: options.initialPluginInstallRecords ?? {},
    readPluginInstallRecords: options.readPluginInstallRecords ?? (async () => ({})),
    subscribeToWrites,
    log,
    watchPath: "/tmp/openclaw.json",
  });
  return {
    watcher,
    ...callbacks,
    log,
    reloader,
    emitWrite(event: ConfigWriteNotification) {
      writeListener?.(event);
    },
  };
}

export type ReloaderHarness = ReturnType<typeof createReloaderHarness>;

export async function flushWatcherChange(harness: ReloaderHarness) {
  harness.watcher.emit("change");
  await flushReload(harness.reloader);
}

function onlyReloadCall(
  callback: ReloaderHarness["onRestart"] | ReloaderHarness["onHotReload"],
): [GatewayReloadPlan, OpenClawConfig] {
  expect(callback).toHaveBeenCalledTimes(1);
  const call = callback.mock.calls[0];
  assert.isDefined(call);
  return [call[0], call[1]];
}

export function getOnlyRestartCall(harness: ReloaderHarness) {
  return onlyReloadCall(harness.onRestart);
}

// Writer-focused cases own a persisted snapshot as well as the notification.
export function createWriteReloaderHarness(
  options: Parameters<typeof createReloaderHarness>[1] = {},
) {
  let persisted: ConfigFileSnapshot;
  const harness = createReloaderHarness(async () => persisted, options);
  return {
    ...harness,
    emitWrite: (write: ConfigWriteNotification) => {
      persisted = write.snapshot;
      harness.emitWrite(write);
    },
  };
}

export function getOnlyHotReloadCall(harness: ReloaderHarness) {
  return onlyReloadCall(harness.onHotReload);
}

export function registerReverseHotReloadTest() {
  it("plans the reverse hot reload when config A commits before config B supersedes its tail", async () => {
    const initialConfig = {
      gateway: { reload: {} },
      hooks: { enabled: true, token: "test-token", path: "/old" },
    } satisfies OpenClawConfig;
    const configA = {
      ...initialConfig,
      hooks: { ...initialConfig.hooks, path: "/a" },
    } satisfies OpenClawConfig;
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(makeSnapshot({ config: configA, hash: "post-commit-a" }))
      .mockResolvedValue(makeSnapshot({ config: initialConfig, hash: "reverse-b" }));
    const { promise: committed, resolve: recordCommitted } = createDeferred();
    const { promise: tailGate, resolve: releaseTail } = createDeferred();
    const onHotReload = vi.fn(
      async (
        plan: GatewayReloadPlan,
        nextConfig: OpenClawConfig,
        ownership: GatewayConfigReloadTransactionOwnership,
      ) => {
        ownership.markRuntimeCommitted(nextConfig, plan);
        if (nextConfig === configA) {
          recordCommitted?.();
          await tailGate;
        }
        return "applied" as const;
      },
    );
    const promoteSnapshot = vi.fn(async (_snapshot: ConfigFileSnapshot, _reason: string) => true);
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig,
      onHotReload,
      promoteSnapshot,
    });
    await harness.reloader.ready;

    harness.watcher.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await committed;

    harness.watcher.emit("change");
    releaseTail();
    await waitForReloadState(() => onHotReload.mock.calls.length === 2);
    await flushReload(harness.reloader);

    expect(onHotReload).toHaveBeenCalledTimes(2);
    expect(onHotReload.mock.calls.map(([, config]) => config)).toEqual([configA, initialConfig]);
    expect(onHotReload.mock.calls[1]?.[0].hotReasons).toContain("hooks.path");
    expect(harness.onConfigAccepted).toHaveBeenCalledTimes(2);
    expect(harness.onConfigAccepted.mock.calls.map((call) => call[0])).toEqual([
      configA,
      initialConfig,
    ]);
    expect(harness.onConfigApplied).toHaveBeenCalledTimes(2);
    expect(harness.onConfigApplied.mock.calls.map(([, config]) => config)).toEqual([
      configA,
      initialConfig,
    ]);
    expect(promoteSnapshot.mock.calls.map(([snapshot]) => snapshot.hash)).toEqual([
      "post-commit-a",
      "reverse-b",
    ]);
  });
}
