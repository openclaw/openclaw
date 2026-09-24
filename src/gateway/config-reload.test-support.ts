import chokidar from "chokidar";
import { expect, vi, type TestContext } from "vitest";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import type {
  ConfigFileSnapshot,
  ConfigWriteNotification,
  OpenClawConfig,
} from "../config/config.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  startGatewayConfigReloader as startGatewayConfigReloaderImpl,
  type GatewayConfigReloadTransactionOwnership,
  type GatewayReloadPlan,
} from "./config-reload.js";
import { createWatcherMock } from "./config-reload.watcher.test-support.js";

const activeReloaders = new Set<ReturnType<typeof startGatewayConfigReloaderImpl>>();
let currentTest: { timeout: number; signal: AbortSignal } | undefined;

export function prepareConfigReloadTest({ task, signal }: TestContext) {
  currentTest = { timeout: task.timeout, signal };
}

export function startGatewayConfigReloader(
  ...args: Parameters<typeof startGatewayConfigReloaderImpl>
) {
  const reloader = startGatewayConfigReloaderImpl(...args);
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

export async function flushReload(
  reloader: Pick<ReturnType<typeof startGatewayConfigReloaderImpl>, "isReloading">,
  delayMs = 0,
) {
  await vi.advanceTimersByTimeAsync(delayMs);
  await waitForReloadState(() => !reloader.isReloading());
}

export function makeGatewayPortConfig(port: number): OpenClawConfig {
  return { gateway: { reload: {}, port } };
}

export function makeSnapshot(partial: Partial<ConfigFileSnapshot> = {}): ConfigFileSnapshot {
  const config = partial.config ?? {};
  const sourceConfig = (partial.sourceConfig ??
    partial.config ??
    {}) as ConfigFileSnapshot["sourceConfig"];
  const runtimeConfig = partial.runtimeConfig ?? partial.config ?? {};
  const parsed = partial.parsed ?? sourceConfig;
  return {
    path: "/tmp/openclaw.json",
    includedPaths: [],
    exists: true,
    raw: partial.exists === false ? null : JSON.stringify(parsed),
    parsed,
    sourceConfig,
    resolved: sourceConfig,
    valid: true,
    runtimeConfig,
    config,
    issues: [],
    warnings: [],
    legacyIssues: [],
    ...partial,
  };
}

export function makeZeroDebounceHookSnapshot(hash: string): ConfigFileSnapshot {
  return makeSnapshot({
    sourceConfig: {
      gateway: { reload: {} },
      hooks: { enabled: true },
    },
    runtimeConfig: {
      gateway: { reload: {} },
      hooks: { enabled: true },
    },
    config: {
      gateway: { reload: {} },
      hooks: { enabled: true },
    },
    hash,
  });
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
    writtenAtMs: Date.now(),
  };
}

export function createReloaderHarness(
  readSnapshot: () => Promise<ConfigFileSnapshot>,
  options: {
    initialConfig?: OpenClawConfig;
    initialCompareConfig?: OpenClawConfig;
    initialRuntimeIgnoredPaths?: ConfigFileSnapshot["runtimeIgnoredPaths"];
    initialSnapshotRawHash?: string | null;
    initialAuthoredConfig?: unknown;
    initialIncludedPaths?: readonly string[];
    initialSnapshotValid?: boolean;
    initialSnapshotIssues?: ConfigFileSnapshot["issues"];
    prepareConfigCandidate?: Parameters<
      typeof startGatewayConfigReloader
    >[0]["prepareConfigCandidate"];
    promoteSnapshot?: (snapshot: ConfigFileSnapshot, reason: string) => Promise<boolean>;
    initialPluginInstallRecords?: Record<string, PluginInstallRecord>;
    readPluginInstallRecords?: () => Promise<Record<string, PluginInstallRecord>>;
    runTransaction?: <T>(run: () => Promise<T>) => Promise<T>;
    onConfigCandidateObserved?: () => void;
    onConfigAccepted?: Parameters<typeof startGatewayConfigReloader>[0]["onConfigAccepted"];
    onEffectiveConfigUnchanged?: Parameters<
      typeof startGatewayConfigReloader
    >[0]["onEffectiveConfigUnchanged"];
    onConfigApplied?: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
    onConfigRevisionApplied?: (hash: string) => void;
    onConfigChange?: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
    onNoopConfigCommit?: Parameters<typeof startGatewayConfigReloader>[0]["onNoopConfigCommit"];
    onHotReload?: Parameters<typeof startGatewayConfigReloader>[0]["onHotReload"];
    onRestart?: Parameters<typeof startGatewayConfigReloader>[0]["onRestart"];
  } = {},
) {
  const watcher = createWatcherMock();
  vi.spyOn(chokidar, "watch").mockReturnValue(watcher as unknown as never);
  const onConfigChange = vi.fn(
    options.onConfigChange ?? (async (_plan: GatewayReloadPlan, _nextConfig: OpenClawConfig) => {}),
  );
  const onConfigApplied = vi.fn(
    options.onConfigApplied ??
      (async (_plan: GatewayReloadPlan, _nextConfig: OpenClawConfig) => {}),
  );
  const onConfigAccepted = vi.fn(options.onConfigAccepted ?? (async () => {}));
  const onConfigRevisionApplied = vi.fn(options.onConfigRevisionApplied ?? (() => {}));
  const onReloadEnabledChange = vi.fn<(enabled: boolean) => void>();
  const onEffectiveConfigUnchanged = vi.fn(
    options.onEffectiveConfigUnchanged ?? (async () => ({ rollback: async () => {} })),
  );
  const onNoopConfigCommit = vi.fn(
    options.onNoopConfigCommit ??
      (async (
        _plan: GatewayReloadPlan,
        _nextConfig: OpenClawConfig,
        _ownership: GatewayConfigReloadTransactionOwnership,
      ) => {}),
  );
  const onHotReload = vi.fn(
    options.onHotReload ??
      (async (
        _plan: GatewayReloadPlan,
        _nextConfig: OpenClawConfig,
        _ownership: GatewayConfigReloadTransactionOwnership,
      ) => "applied" as const),
  );
  const onRestart = vi.fn(
    options.onRestart ?? ((_plan: GatewayReloadPlan, _nextConfig: OpenClawConfig) => {}),
  );
  const onConfigCandidateCommitted = vi.fn(
    (_info: { path: string; persistedHash: string | null; changedPaths: readonly string[] }) => {},
  );
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
    testDebounceMs: 0,
    initialConfig,
    initialCompareConfig: options.initialCompareConfig,
    initialRuntimeIgnoredPaths: options.initialRuntimeIgnoredPaths,
    initialSnapshotRawHash:
      options.initialSnapshotRawHash === undefined
        ? hashConfigRaw(JSON.stringify(options.initialAuthoredConfig ?? initialConfig))
        : options.initialSnapshotRawHash,
    initialAuthoredConfig: options.initialAuthoredConfig ?? initialConfig,
    initialIncludedPaths: options.initialIncludedPaths,
    initialSnapshotValid: options.initialSnapshotValid ?? true,
    initialSnapshotIssues: options.initialSnapshotIssues ?? [],
    ...(options.prepareConfigCandidate
      ? { prepareConfigCandidate: options.prepareConfigCandidate }
      : {}),
    readSnapshot,
    promoteSnapshot: options.promoteSnapshot,
    initialPluginInstallRecords: options.initialPluginInstallRecords ?? {},
    readPluginInstallRecords: options.readPluginInstallRecords ?? (async () => ({})),
    subscribeToWrites,
    ...(options.onConfigCandidateObserved
      ? { onConfigCandidateObserved: options.onConfigCandidateObserved }
      : {}),
    onConfigChange,
    onConfigApplied,
    onConfigRevisionApplied,
    onReloadEnabledChange,
    onConfigAccepted,
    onEffectiveConfigUnchanged,
    onNoopConfigCommit,
    onHotReload,
    onRestart,
    onConfigCandidateCommitted,
    ...(options.runTransaction ? { runTransaction: options.runTransaction } : {}),
    log,
    watchPath: "/tmp/openclaw.json",
  });
  return {
    watcher,
    onConfigChange,
    onConfigApplied,
    onConfigRevisionApplied,
    onReloadEnabledChange,
    onConfigAccepted,
    onEffectiveConfigUnchanged,
    onNoopConfigCommit,
    onHotReload,
    onRestart,
    onConfigCandidateCommitted,
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

export function getOnlyRestartCall(harness: ReloaderHarness): [GatewayReloadPlan, OpenClawConfig] {
  expect(harness.onRestart).toHaveBeenCalledTimes(1);
  const call = harness.onRestart.mock.calls[0];
  if (!call) {
    throw new Error("expected one restart call");
  }
  return [call[0], call[1]];
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

export function getOnlyHotReloadCall(
  harness: ReloaderHarness,
): [GatewayReloadPlan, OpenClawConfig] {
  expect(harness.onHotReload).toHaveBeenCalledTimes(1);
  const call = harness.onHotReload.mock.calls[0];
  if (!call) {
    throw new Error("expected one hot reload call");
  }
  return [call[0], call[1]];
}
