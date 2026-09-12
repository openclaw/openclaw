import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import nodePath from "node:path";
import { isDeepStrictEqual } from "node:util";
// Gateway config hot-reload watcher.
// Diffs config/plugin install snapshots and dispatches hot reload or restart plans.
import chokidar from "chokidar";
import type { ConfigRuntimeEnvPublication } from "../config/config-env-vars.js";
import {
  configSnapshotAuditRecordMatchesPath,
  fingerprintConfigSnapshotAuthoredConfig,
  readConfigSnapshotAuditRecord,
  readLatestConfigSnapshotAuditRecord,
  upsertConfigSnapshotAuditRecord,
} from "../config/config-journal-snapshot.js";
import {
  appendConfigAuditRecordSync,
  capConfigAuditIssues,
  capConfigAuditPaths,
  type ConfigExternalChangeAuditRecord,
} from "../config/io.audit.js";
import type { ConfigWriteNotification } from "../config/io.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { serializeConfigResolutionFacts } from "../config/resolution-facts.js";
import { hashRuntimeConfigValue, resolveConfigWriteFollowUp } from "../config/runtime-snapshot.js";
import type { RuntimeConfigSnapshotRefreshOptions } from "../config/runtime-snapshot.js";
import {
  getRuntimeConfigWriteApplication,
  type RuntimeConfigWriteApplicationClaim,
  type RuntimeConfigWriteApplicationStatus,
} from "../config/runtime-write-application.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { getProcessGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { hashStableJson } from "../plugins/installed-plugin-index-hash.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import {
  getPluginRuntimeGeneration,
  PluginRuntimeApplicationError,
  type PluginLifecycleRuntimeApply,
  type PluginRuntimeApplication,
} from "../plugins/lifecycle.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import {
  runOutsidePluginLifecycleLease,
  withPluginLifecycleLease,
} from "../plugins/plugin-lifecycle-lease.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { bumpSkillsSnapshotVersion } from "../skills/runtime/refresh-state.js";
import { createConfigAppliedRevisionTracker } from "./config-applied-revision.js";
import { diffConfigPaths, diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  isNoopGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
  resolvePluginInstallReloadMetadata,
  type GatewayReloadPlan,
} from "./config-reload-plan.js";
import { resolveGatewayReloadSettings } from "./config-reload-settings.js";
import type {
  GatewayHotReloadApplication,
  GatewayHotReloadStatus,
} from "./config-reload-status.types.js";
import {
  assertReloadPublicationCurrent,
  GatewayConfigReloadSupersededError,
} from "./server-reload-contracts.js";

export type { GatewayReloadPlan } from "./config-reload-plan.js";
const MISSING_CONFIG_RETRY_DELAY_MS = 150;
const MISSING_CONFIG_MAX_RETRIES = 2;

// Watcher 'error' events (for example EMFILE/ENOSPC inotify exhaustion) close
// the chokidar watcher. Re-create it with bounded backoff so a transient fault
// does not permanently kill config hot-reload. If all native retries are
// exhausted (typical when the host has insufficient inotify watches), fall
// back to polling mode before giving up entirely.
const WATCHER_RECREATE_MAX_RETRIES = 3;
const WATCHER_RECREATE_BACKOFF_MS = [500, 2000, 5000] as const;

function resolveChokidarUsePolling(degradedToPolling: boolean): boolean {
  const envPoll = process.env.CHOKIDAR_USEPOLLING;
  if (envPoll !== undefined) {
    const envLower = envPoll.toLowerCase();
    if (envLower === "false" || envLower === "0") {
      return false;
    }
    if (envLower === "true" || envLower === "1") {
      return true;
    }
    return Boolean(envLower);
  }
  return Boolean(process.env.VITEST) || degradedToPolling;
}

type GatewayConfigReloader = {
  /** Candidate validation and watcher creation; stop owns this work immediately. */
  ready: Promise<void>;
  isReady: () => boolean;
  stop: () => Promise<void>;
  hotReloadStatus: () => GatewayHotReloadStatus | undefined;
  applyPluginLifecycleChange: PluginLifecycleRuntimeApply;
  isReloading: () => boolean;
};

type PluginInstallRecords = Record<string, PluginInstallRecord>;

type InProcessConfigCandidate = {
  config: OpenClawConfig;
  compareConfig: OpenClawConfig;
  persistedHash: string;
  afterWrite?: ConfigWriteNotification["afterWrite"];
  preparedCandidate?: ConfigWriteNotification["preparedCandidate"];
  runtimeRefresh?: RuntimeConfigSnapshotRefreshOptions;
  application?: RuntimeConfigWriteApplicationClaim;
  epoch: number;
};

export type GatewayConfigReloadTransactionOwnership = {
  isCurrent: () => boolean;
  checkpoint: () => Promise<void>;
  withRestartPreparation: <T>(
    run: (ownership: GatewayConfigReloadTransactionOwnership) => Promise<T>,
  ) => Promise<T>;
  assertInvokerOwned?: () => void;
  markRuntimeCommitted: (runtimeConfig: OpenClawConfig, plan: GatewayReloadPlan) => void;
  commitRuntimeEnv: () => void;
  publishRuntimeEnv: () => void;
  rollbackRuntimeEnv: () => void;
  reapplyRuntimeOverlays: (config: OpenClawConfig) => OpenClawConfig;
  runtimeEnv?: NonNullable<ConfigWriteNotification["preparedCandidate"]>["runtimeEnv"];
  runtimeRefresh?: RuntimeConfigSnapshotRefreshOptions;
};

type PreparedGatewayConfigCandidate = {
  runtimeConfig: OpenClawConfig;
  compareConfig: OpenClawConfig;
  runtimeEnv?: NonNullable<ConfigWriteNotification["preparedCandidate"]>["runtimeEnv"];
  reapplyRuntimeOverlays?: (config: OpenClawConfig) => OpenClawConfig;
  reapplyCompareOverlays?: (config: OpenClawConfig) => OpenClawConfig;
};

function asPluginInstallConfig(records: PluginInstallRecords): OpenClawConfig {
  return {
    plugins: {
      installs: records,
    },
  };
}

function isConfigReloadSuperseded(error: unknown): boolean {
  // Only completed rollback preserves the direct cause. Cleanup failures and
  // published replacements must settle instead of transferring the write.
  const cause =
    error instanceof PluginRuntimeApplicationError && !error.details.committed
      ? error.cause
      : error;
  return cause instanceof GatewayConfigReloadSupersededError;
}

export function startGatewayConfigReloader(opts: {
  initialConfig: OpenClawConfig;
  initialCompareConfig?: OpenClawConfig;
  initialSnapshotRawHash: string | null;
  initialAuthoredConfig: unknown;
  initialIncludedPaths?: readonly string[];
  initialSnapshotValid: boolean;
  initialSnapshotIssues: ConfigFileSnapshot["issues"];
  /** Keeps watcher-heavy tests immediate without reopening config-level debounce tuning. */
  testDebounceMs?: number;
  /** Per-instance test hook for synchronizing filesystem edits with watcher startup. */
  onWatcherReady?: () => void;
  /** Source acceptance controls ancillary reload owners even when runtime application is off. */
  onReloadEnabledChange?: (enabled: boolean) => void;
  prepareConfigCandidate?: (params: {
    runtimeConfig: OpenClawConfig;
    sourceConfig: OpenClawConfig;
    previousSourceConfig: OpenClawConfig;
  }) => Promise<PreparedGatewayConfigCandidate>;
  initialInternalWriteHash?: string | null;
  readSnapshot: (activeSourceConfig: OpenClawConfig) => Promise<ConfigFileSnapshot>;
  /** Pauses restart emission synchronously when a matching disk candidate is observed. */
  onConfigCandidateObserved?: () => void;
  onConfigChange?: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
  /** Publishes runtime state after a hot or no-op config transaction. */
  onConfigApplied?: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
  /** Runs synchronously when a config transaction publishes its runtime state. */
  onRuntimeConfigCommitted?: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void;
  /** Publishes the resolved source-config revision accepted by the active runtime. */
  onConfigRevisionApplied?: (hash: string) => void;
  /** Reads the same restart owner that fences publication of the applied revision. */
  hasOutstandingGatewayRestart?: () => boolean;
  /** Retires rejected lifecycle work after any newer config transaction is accepted. */
  onConfigAccepted?: (
    nextConfig: OpenClawConfig,
    ownership: GatewayConfigReloadTransactionOwnership,
    sourceConfig: OpenClawConfig,
    acceptance: {
      runtimeApplied: boolean;
      publishSource?: () => Promise<() => Promise<void>>;
    },
  ) => void | (() => Promise<void>) | Promise<void | (() => Promise<void>)>;
  /** Publishes a newer source snapshot when effective runtime bytes are unchanged. */
  onEffectiveConfigUnchanged?: (
    nextConfig: OpenClawConfig,
    ownership: GatewayConfigReloadTransactionOwnership,
    sourceConfig: OpenClawConfig,
  ) => Promise<{
    rollback: () => Promise<void>;
    /** Runs only when this exact source publication can no longer roll back. */
    commit?: () => void;
  }>;
  /**
   * Fires once per accepted candidate whose persisted content changed —
   * regardless of writer (gateway RPC, agent/CLI config_set, doctor, hand
   * edit) and of whether the runtime applied it. The single notification
   * point for change listeners such as the config.changed broadcast.
   */
  onConfigCandidateCommitted?: (info: {
    path: string;
    persistedHash: string | null;
    changedPaths: readonly string[];
  }) => void;
  onNoopConfigCommit: (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    ownership: GatewayConfigReloadTransactionOwnership,
    sourceConfig: OpenClawConfig,
  ) => Promise<void | GatewayHotReloadApplication>;
  onHotReload: (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    ownership: GatewayConfigReloadTransactionOwnership,
    sourceConfig: OpenClawConfig,
  ) => Promise<GatewayHotReloadApplication>;
  onRestart: (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    ownership: GatewayConfigReloadTransactionOwnership,
    sourceConfig: OpenClawConfig,
  ) => void | Promise<void>;
  /** Keeps one accepted config transaction inside the Gateway work fence. */
  runTransaction?: <T>(run: () => Promise<T>) => Promise<T>;
  promoteSnapshot?: (snapshot: ConfigFileSnapshot, reason: string) => Promise<boolean>;
  initialPluginInstallRecords?: PluginInstallRecords;
  readPluginInstallRecords?: () => Promise<PluginInstallRecords>;
  subscribeToWrites?: (listener: (event: ConfigWriteNotification) => void) => () => void;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  watchPath: string;
}): GatewayConfigReloader {
  const initialSourceConfig = opts.initialCompareConfig ?? opts.initialConfig;
  let currentConfig = opts.initialConfig;
  let currentCompareConfig = initialSourceConfig;
  let currentSourceConfig = initialSourceConfig;
  let currentRawHash = opts.initialSnapshotRawHash;
  let lastObservedRawHash = opts.initialSnapshotRawHash;
  let currentFingerprintedAuthoredConfig = fingerprintConfigSnapshotAuthoredConfig(
    opts.initialAuthoredConfig,
    { env: process.env, homedir },
  );
  let currentRuntimeEnvSourceConfig = initialSourceConfig;
  let currentReapplyRuntimeOverlays = (config: OpenClawConfig) => config;
  let currentRuntimeRefresh: RuntimeConfigSnapshotRefreshOptions | undefined;
  const resolveSettings = (config: OpenClawConfig) => {
    const resolved = resolveGatewayReloadSettings(config);
    return opts.testDebounceMs === undefined
      ? resolved
      : { ...resolved, debounceMs: opts.testDebounceMs };
  };
  let settings = resolveSettings(currentConfig);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let running = false;
  let stopped = false;
  let initialized = false;
  const lifecycle = new AbortController();
  const withRestartPreparation = <T>(
    ownership: GatewayConfigReloadTransactionOwnership,
    checkpointOwned: (assertOwned: () => void) => Promise<void>,
    run: (ownership: GatewayConfigReloadTransactionOwnership) => Promise<T>,
  ): Promise<T> =>
    runOutsidePluginLifecycleLease(() =>
      withPluginLifecycleLease({ signal: lifecycle.signal }, async (lease) => {
        // Accepted restart work outlives the requesting mutation. Reacquire exclusion
        // while retaining the same source observation and stopped/superseded checks.
        const current = {
          ...ownership,
          assertInvokerOwned: () => lease.assertOwned(),
          checkpoint: () => checkpointOwned(() => lease.assertOwned()),
        };
        await current.checkpoint();
        const result = await run(current);
        await current.checkpoint();
        return result;
      }),
    );
  let watcherReload: Promise<void> | undefined;
  const activeReloads = new Set<Promise<unknown>>();
  let activeReloadCompletion: Promise<unknown> = Promise.resolve();
  let pluginOperationTail: Promise<unknown> = Promise.resolve();
  let missingConfigRetries = 0;
  let sourceObservation: {
    epoch: number;
    writerEpoch: number;
    read?: Promise<[ConfigFileSnapshot, PluginInstallRecords]>;
  } = { epoch: 0, writerEpoch: 0 };
  let pendingInProcessConfig: InProcessConfigCandidate | null = null;
  let activeInProcessConfig: InProcessConfigCandidate | null = null;
  let watcherIntentCandidate: InProcessConfigCandidate | null = null;
  let watcherIntentCameFromPendingWrite = false;
  const settleApplication = (
    candidate: InProcessConfigCandidate | null,
    status: RuntimeConfigWriteApplicationStatus,
  ) => {
    candidate?.application?.settle(status);
  };
  let startupInternalWriteHash = opts.initialInternalWriteHash ?? null;
  let lastAppliedWriteHash: string | null = null;
  let lastSourceOnlyWriteHash: string | null = null;
  let lastSourceOnlyReapplyRuntimeOverlays: ((config: OpenClawConfig) => OpenClawConfig) | null =
    null;
  let lastSourceOnlyRuntimeRefresh: RuntimeConfigSnapshotRefreshOptions | undefined;
  let lastSourceOnlyRuntimeConfig: OpenClawConfig | null = null;
  let lastSourceOnlySourceConfig: OpenClawConfig | null = null;

  const appendExternalAudit = (
    record: Omit<ConfigExternalChangeAuditRecord, "ts" | "source" | "event" | "configPath">,
  ) => {
    appendConfigAuditRecordSync({
      env: process.env,
      homedir,
      record: {
        ts: new Date().toISOString(),
        source: "config-io",
        event: "config.external",
        configPath: opts.watchPath,
        ...record,
      },
    });
  };

  // CAS token is the unfiltered slot: a slot owned by another config path must
  // still be the expected value so this path can take the slot over. Only a
  // path-matched slot may seed reconcile baselines.
  let currentSnapshotSlot: ReturnType<typeof readLatestConfigSnapshotAuditRecord> = null;

  const updateAcceptedSnapshot = (rawHash: string, authoredConfig: unknown) => {
    currentRawHash = rawHash;
    currentFingerprintedAuthoredConfig = fingerprintConfigSnapshotAuthoredConfig(authoredConfig, {
      env: process.env,
      homedir,
    });
    const updatedSlot = upsertConfigSnapshotAuditRecord({
      configPath: opts.watchPath,
      rawHash,
      authoredConfig,
      expectedSnapshot: currentSnapshotSlot,
    });
    if (updatedSlot) {
      currentSnapshotSlot = updatedSlot;
      return;
    }
    currentSnapshotSlot = readLatestConfigSnapshotAuditRecord();
    if (configSnapshotAuditRecordMatchesPath(currentSnapshotSlot, opts.watchPath)) {
      currentRawHash = currentSnapshotSlot.rawHash;
      currentFingerprintedAuthoredConfig = currentSnapshotSlot.fingerprintedAuthoredConfig;
    }
  };

  // An observed source must compare against current ledger rows, not a frozen caller cache.
  const readCurrentInstallRecords = () =>
    withPluginCache(createPluginCache(), loadInstalledPluginIndexInstallRecords);
  let currentPluginInstallRecords: PluginInstallRecords = {};
  let completedPluginApplication:
    | {
        runtime: PluginRuntimeApplication;
        snapshot: ConfigFileSnapshot;
        installRecords: PluginInstallRecords;
      }
    | undefined;
  const readPluginInstallRecords = opts.readPluginInstallRecords ?? readCurrentInstallRecords;
  const appliedRevision = createConfigAppliedRevisionTracker({
    onConfigApplied: opts.onConfigApplied,
    onRevisionApplied: opts.onConfigRevisionApplied,
  });

  const clearReloadTimer = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = null;
  };
  const scheduleAfter = (wait: number) => {
    if (stopped || !initialized) {
      return;
    }
    // Coalesce filesystem/write-listener bursts into one reload pass. Config
    // writes often touch temp and final paths in quick succession.
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      startTrackedReload();
    }, wait);
  };
  const schedule = () => {
    scheduleAfter(settings.debounceMs);
  };
  const prepareRestart = async (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    ownership: GatewayConfigReloadTransactionOwnership,
    sourceConfig: OpenClawConfig,
  ) => {
    try {
      // Every accepted restart candidate validates inside its config
      // transaction. Only downstream signal delivery may coalesce.
      await opts.onRestart(plan, nextConfig, ownership, sourceConfig);
    } catch (err) {
      if (isConfigReloadSuperseded(err)) {
        opts.log.info(`config restart superseded: ${String(err)}`);
      } else {
        opts.log.error(`config restart failed: ${String(err)}`);
      }
      // Failed restart admission must reject the transaction. Otherwise the
      // persisted snapshot becomes the baseline and the same config cannot retry.
      throw err;
    }
  };

  const handleMissingSnapshot = (snapshot: ConfigFileSnapshot): boolean => {
    if (snapshot.exists) {
      missingConfigRetries = 0;
      return false;
    }
    if (missingConfigRetries < MISSING_CONFIG_MAX_RETRIES) {
      missingConfigRetries += 1;
      opts.log.info(
        `config reload retry (${missingConfigRetries}/${MISSING_CONFIG_MAX_RETRIES}): config file not found`,
      );
      scheduleAfter(MISSING_CONFIG_RETRY_DELAY_MS);
      return true;
    }
    opts.log.warn("config reload skipped (config file not found)");
    return true;
  };

  const applySnapshot = async (
    sourceSnapshot: ConfigFileSnapshot,
    candidate?: InProcessConfigCandidate | null,
    initialEpoch = sourceObservation.epoch,
    {
      pluginLifecycle,
      onRuntimeCommitted,
      assertInvokerOwned: pluginInvokerGuard,
    }: {
      pluginLifecycle?: GatewayReloadPlan["pluginLifecycle"];
      onRuntimeCommitted?: () => void;
      assertInvokerOwned?: () => void;
    } = {},
  ) => {
    let transactionEpoch = initialEpoch;
    const { hash: persistedHash } = sourceSnapshot;
    const {
      config: candidateRuntimeConfig = sourceSnapshot.config,
      compareConfig: nextSourceConfig = sourceSnapshot.sourceConfig,
      afterWrite,
      preparedCandidate: preflightCandidate,
      runtimeRefresh,
      application,
    } = candidate ?? {};
    const settleRuntimeApplication = (result: GatewayHotReloadApplication = "applied") => {
      const status = typeof result === "string" ? result : result.status;
      // A watcher replay must not turn recovery-owned runtime work into a success receipt.
      application?.settle(
        opts.hasOutstandingGatewayRestart?.() ? "applied-restart-required" : status,
      );
    };
    let nextPluginInstallRecords = currentPluginInstallRecords;
    let committedRuntimeConfig: OpenClawConfig | null = null;
    let rejected = false;
    const isCurrent = () => !stopped && !rejected && sourceObservation.epoch === transactionEpoch;
    const assertInvokerOwned = () => {
      // Published work must finish its cleanup and receipt even if its invoker closes.
      if (!committedRuntimeConfig) {
        pluginInvokerGuard?.();
      }
    };
    const assertCurrent = () => {
      assertInvokerOwned();
      assertReloadPublicationCurrent(isCurrent(), false);
    };
    const checkpointOwned = async (assertOwned: () => void) => {
      if (stopped || rejected) {
        throw new GatewayConfigReloadSupersededError();
      }
      assertOwned();
      if (sourceObservation.epoch !== transactionEpoch) {
        const observed = sourceObservation;
        if (observed.writerEpoch > transactionEpoch) {
          throw new GatewayConfigReloadSupersededError();
        }
        // Read under this observation, not the reload queue: the active transaction
        // owns that queue and may already have stopped its plugin services.
        const [snapshot, installs] = await (observed.read ??= Promise.all([
          opts.readSnapshot(currentRuntimeEnvSourceConfig),
          readPluginInstallRecords(),
        ]));
        if (
          stopped ||
          sourceObservation !== observed ||
          !snapshot.exists ||
          !snapshot.valid ||
          typeof persistedHash !== "string" ||
          snapshot.hash !== persistedHash ||
          diffConfigPaths(snapshot.sourceConfig, nextSourceConfig).length > 0 ||
          !isDeepStrictEqual(installs, nextPluginInstallRecords) ||
          !isDeepStrictEqual(snapshot.includedPaths, sourceSnapshot.includedPaths) ||
          !isDeepStrictEqual(snapshot.includeProvenance, sourceSnapshot.includeProvenance) ||
          !isDeepStrictEqual(
            serializeConfigResolutionFacts(snapshot.sourceConfig),
            serializeConfigResolutionFacts(sourceSnapshot.sourceConfig),
          )
        ) {
          throw new GatewayConfigReloadSupersededError();
        }
        assertOwned();
        transactionEpoch = observed.epoch;
      }
      assertOwned();
      assertReloadPublicationCurrent(isCurrent(), false);
    };
    const checkpoint = async () => {
      try {
        await checkpointOwned(assertInvokerOwned);
      } catch (error) {
        rejected = true;
        throw error;
      }
    };
    const completeApplication = (runtime?: PluginRuntimeApplication) => {
      // Acceptance consumed this observation. A later event keeps its own scheduled work.
      if (isCurrent()) {
        clearReloadTimer();
        pending = false;
      }
      return { runtime, isCurrent };
    };
    assertInvokerOwned();
    // Reprepare against the current accepted env owner. A managed write can
    // finish preflight while another watcher transaction accepts first.
    const preparedCandidate = opts.prepareConfigCandidate
      ? await opts.prepareConfigCandidate({
          runtimeConfig: candidateRuntimeConfig,
          sourceConfig: nextSourceConfig,
          previousSourceConfig: currentRuntimeEnvSourceConfig,
        })
      : preflightCandidate;
    if (stopped) {
      throw new GatewayConfigReloadSupersededError();
    }
    // The full checkpoint below reads candidate install records before reconciling
    // watcher echoes. Recheck the invoking admission after asynchronous preparation.
    assertInvokerOwned();
    const nextConfig = preparedCandidate?.runtimeConfig ?? candidateRuntimeConfig;
    const nextCompareConfig = preparedCandidate?.compareConfig ?? nextSourceConfig;
    const nextConfigRevisionHash = hashRuntimeConfigValue(nextSourceConfig);
    let publishedRuntimeEnv: ConfigRuntimeEnvPublication | undefined;
    let runtimeEnvCommitted = false;
    const nextSettings = resolveSettings(nextConfig);
    const commitPublishedRuntimeEnv = () => {
      runtimeEnvCommitted = true;
      publishedRuntimeEnv?.commit();
      publishedRuntimeEnv = undefined;
    };
    const ownership: GatewayConfigReloadTransactionOwnership = {
      isCurrent,
      checkpoint,
      withRestartPreparation: (run) => withRestartPreparation(ownership, checkpointOwned, run),
      assertInvokerOwned,
      reapplyRuntimeOverlays: preparedCandidate?.reapplyRuntimeOverlays ?? ((config) => config),
      ...(preparedCandidate?.runtimeEnv ? { runtimeEnv: preparedCandidate.runtimeEnv } : {}),
      ...(runtimeRefresh ? { runtimeRefresh } : {}),
      publishRuntimeEnv: () => {
        assertCurrent();
        if (runtimeEnvCommitted) {
          return;
        }
        publishedRuntimeEnv ??= preparedCandidate?.runtimeEnv?.publish();
        assertCurrent();
      },
      rollbackRuntimeEnv: () => {
        if (runtimeEnvCommitted) {
          return;
        }
        publishedRuntimeEnv?.();
        publishedRuntimeEnv = undefined;
      },
      commitRuntimeEnv: commitPublishedRuntimeEnv,
      markRuntimeCommitted: (runtimeConfig, plan) => {
        // Publication can win immediately before a watcher supersedes this
        // transaction. Advance the runtime diff baseline at that exact edge so
        // the newer disk config plans the reverse work instead of diffing stale state.
        commitPublishedRuntimeEnv();
        onRuntimeCommitted?.();
        opts.onRuntimeConfigCommitted?.(plan, runtimeConfig);
        committedRuntimeConfig = runtimeConfig;
        currentConfig = runtimeConfig;
        currentCompareConfig = nextCompareConfig;
        currentSourceConfig = nextSourceConfig;
        currentRuntimeEnvSourceConfig = nextSourceConfig;
        currentReapplyRuntimeOverlays = ownership.reapplyRuntimeOverlays;
        currentRuntimeRefresh = ownership.runtimeRefresh;
        currentPluginInstallRecords = nextPluginInstallRecords;
        settings = resolveSettings(runtimeConfig);
        appliedRevision.defer(plan, nextConfigRevisionHash);
      },
    };
    const configChangedPaths = diffGatewayReloadPaths(
      currentCompareConfig,
      nextCompareConfig,
      listConfigReloadRefinementPrefixes(),
    );
    const configInstallMetadata = resolvePluginInstallReloadMetadata(
      currentCompareConfig,
      nextCompareConfig,
    );
    try {
      nextPluginInstallRecords = await readPluginInstallRecords();
    } catch (err) {
      opts.log.warn(`config reload plugin install record check failed: ${String(err)}`);
    }
    await checkpoint();
    assertCurrent();
    const previousPluginInstallConfig = asPluginInstallConfig(currentPluginInstallRecords);
    const nextPluginInstallConfig = asPluginInstallConfig(nextPluginInstallRecords);
    const pluginInstallRecordChangedPaths = diffConfigPaths(
      previousPluginInstallConfig,
      nextPluginInstallConfig,
    );
    const installMetadata = resolvePluginInstallReloadMetadata(
      previousPluginInstallConfig,
      nextPluginInstallConfig,
    );
    const changedPaths = [...configChangedPaths, ...pluginInstallRecordChangedPaths];
    // Publication can be superseded after its runtime commit but before its
    // lifecycle owner is applied. Finish that owner before the next candidate
    // prepares state that acceptance or restart policy may discard.
    await appliedRevision.flush(currentConfig);
    await checkpoint();
    assertCurrent();
    const completed = completedPluginApplication;
    if (
      pluginLifecycle?.expectedInstallHashes &&
      Object.keys(pluginLifecycle.expectedInstallHashes).length > 0 &&
      completed &&
      completed.runtime.generation === getPluginRuntimeGeneration() &&
      !opts.hasOutstandingGatewayRestart?.() &&
      sourceSnapshot.hash === completed.snapshot.hash &&
      diffConfigPaths(nextSourceConfig, completed.snapshot.sourceConfig).length === 0 &&
      isDeepStrictEqual(sourceSnapshot.includedPaths, completed.snapshot.includedPaths) &&
      isDeepStrictEqual(sourceSnapshot.includeProvenance, completed.snapshot.includeProvenance) &&
      isDeepStrictEqual(
        serializeConfigResolutionFacts(nextSourceConfig),
        serializeConfigResolutionFacts(completed.snapshot.sourceConfig),
      ) &&
      isDeepStrictEqual(nextPluginInstallRecords, completed.installRecords) &&
      Object.entries(pluginLifecycle.expectedInstallHashes).every(
        ([id, hash]) =>
          nextPluginInstallRecords[id] && hashStableJson(nextPluginInstallRecords[id]) === hash,
      )
    ) {
      const registry = getActivePluginRegistry();
      const metadata = getProcessGatewayPluginMetadataSnapshot();
      const expected = pluginLifecycle.expectedSourceDigests ?? {};
      const entries =
        metadata?.index.plugins.filter((entry) => expected[entry.pluginId] !== undefined) ?? [];
      if (entries.length === Object.keys(expected).length) {
        // A completed watcher application can settle this exact committed install.
        // Manual reloads carry no install hashes and always create a replacement.
        const { inspectPluginGenerationSources } =
          await import("../plugins/plugin-generation-source-inspection.js");
        await checkpoint();
        assertCurrent();
        const covered = pluginLifecycle.pluginIds.every((id) => {
          const record = registry?.plugins.find((plugin) => plugin.id === id);
          const instance = record && getPluginInstance(record);
          return (
            completed.runtime.pluginIds.includes(id) &&
            (record?.status === "disabled"
              ? expected[id] === undefined
              : record?.status === "loaded" &&
                instance?.acceptingCalls &&
                expected[id] !== undefined &&
                instance.sourceDigest === expected[id] &&
                completed.runtime.sourceDigests?.[id] === expected[id])
          );
        });
        if (
          covered &&
          completed.runtime.generation === getPluginRuntimeGeneration() &&
          registry === getActivePluginRegistry() &&
          metadata === getProcessGatewayPluginMetadataSnapshot()
        ) {
          const source = inspectPluginGenerationSources(
            entries.map((entry) => ({
              pluginId: entry.pluginId,
              rootDir: entry.rootDir,
              entryFile: entry.source === entry.manifestPath ? entry.source : undefined,
            })),
          );
          for (const [id, digest] of Object.entries(expected)) {
            if (source.sourceDigests[id] !== digest) {
              throw new Error(`Plugin ${id} captured source changed after installation`);
            }
          }
          source.assertSourceCurrent();
          assertCurrent();
          application?.settle("applied");
          return completeApplication(completed.runtime);
        }
      }
    }
    const commitReloadBaseline = async (
      options: {
        runtimeApplied?: boolean;
        publishSource?: () => Promise<() => Promise<void>>;
      } = {},
    ) => {
      await checkpoint();
      assertCurrent();
      // A prior transaction may publish runtime state immediately before a
      // newer write supersedes it. Commit that runtime owner before accepting
      // a baseline-only candidate, which can discard prepared lifecycle state.
      await appliedRevision.flush(currentConfig);
      await checkpoint();
      assertCurrent();
      // Persisted content changed even when the runtime skipped applying it
      // (writer intent, reload mode off): change listeners still refresh.
      const notifyCommitted = () => {
        opts.onReloadEnabledChange?.(nextSettings.mode !== "off");
        if (changedPaths.length > 0) {
          opts.onConfigCandidateCommitted?.({
            path: opts.watchPath,
            persistedHash: persistedHash ?? null,
            changedPaths,
          });
        }
      };
      let rollbackAcceptedSource: (() => Promise<void>) | undefined;
      try {
        const acceptedSourceRollback = await opts.onConfigAccepted?.(
          committedRuntimeConfig ?? nextConfig,
          ownership,
          nextSourceConfig,
          {
            runtimeApplied: options.runtimeApplied !== false,
            ...(options.publishSource ? { publishSource: options.publishSource } : {}),
          },
        );
        if (typeof acceptedSourceRollback === "function") {
          rollbackAcceptedSource = acceptedSourceRollback;
        }
        await checkpoint();
        assertCurrent();
        rollbackAcceptedSource ??= await options.publishSource?.();
        await checkpoint();
        assertCurrent();
        currentSourceConfig = nextSourceConfig;
        updateAcceptedSnapshot(hashConfigRaw(sourceSnapshot.raw), sourceSnapshot.parsed);
        if (options.runtimeApplied === false) {
          // Persisted-but-skipped candidates are not runtime truth. Keep the
          // effective baseline so a later safe edit cannot publish them indirectly.
          lastSourceOnlyWriteHash = persistedHash ?? null;
          lastSourceOnlyReapplyRuntimeOverlays = ownership.reapplyRuntimeOverlays;
          lastSourceOnlyRuntimeRefresh = ownership.runtimeRefresh;
          lastSourceOnlyRuntimeConfig = nextConfig;
          lastSourceOnlySourceConfig = nextSourceConfig;
          notifyCommitted();
          return;
        }
        // Runtime owners publish env at their commit edge. Keep this idempotent
        // fallback for effective-config-unchanged transactions without a
        // dedicated runtime publication callback.
        ownership.publishRuntimeEnv();
        currentRuntimeEnvSourceConfig = nextSourceConfig;
        if (persistedHash === lastSourceOnlyWriteHash) {
          lastSourceOnlyWriteHash = null;
          lastSourceOnlyReapplyRuntimeOverlays = null;
          lastSourceOnlyRuntimeRefresh = undefined;
          lastSourceOnlyRuntimeConfig = null;
          lastSourceOnlySourceConfig = null;
        }
        currentConfig = committedRuntimeConfig ?? nextConfig;
        currentCompareConfig = nextCompareConfig;
        currentReapplyRuntimeOverlays = ownership.reapplyRuntimeOverlays;
        currentRuntimeRefresh = ownership.runtimeRefresh;
        currentPluginInstallRecords = nextPluginInstallRecords;
        settings = committedRuntimeConfig ? resolveSettings(committedRuntimeConfig) : nextSettings;
        commitPublishedRuntimeEnv();
      } catch (error) {
        ownership.rollbackRuntimeEnv();
        await rollbackAcceptedSource?.();
        throw error;
      }
      notifyCommitted();
    };
    if (changedPaths.length === 0 && !pluginLifecycle) {
      let publishedSource: { rollback: () => Promise<void>; commit?: () => void } | undefined;
      let publishedSourceRollback: (() => Promise<void>) | undefined;
      let publishedSourceRolledBack = false;
      const publishSource = opts.onEffectiveConfigUnchanged
        ? async () => {
            publishedSource ??= await opts.onEffectiveConfigUnchanged!(
              nextConfig,
              ownership,
              nextSourceConfig,
            );
            publishedSourceRollback ??= async () => {
              publishedSourceRolledBack = true;
              await publishedSource?.rollback();
            };
            return publishedSourceRollback;
          }
        : undefined;
      await commitReloadBaseline(publishSource ? { publishSource } : {});
      if (!publishedSourceRolledBack) {
        publishedSource?.commit?.();
      }
      opts.onConfigRevisionApplied?.(nextConfigRevisionHash);
      settleRuntimeApplication();
      return completeApplication();
    }

    // Rebuild skills on the next turn so sessions do not advertise removed tools.
    const skillsChangedPath = changedPaths.find(
      (path) => path === "skills" || path.startsWith("skills."),
    );
    if (skillsChangedPath !== undefined) {
      bumpSkillsSnapshotVersion({ reason: "config-change", changedPath: skillsChangedPath });
      opts.log.info(`skills snapshot invalidated by config change (${skillsChangedPath})`);
    }

    const followUp = resolveConfigWriteFollowUp(pluginLifecycle ? undefined : afterWrite);
    opts.log.info(
      changedPaths.length > 0
        ? `config change detected; evaluating reload (${changedPaths.join(", ")})`
        : "plugin metadata changed with identical config; applying plugin lifecycle",
    );
    if (followUp.mode === "none") {
      opts.log.info(`config reload skipped by writer intent (${followUp.reason})`);
      await commitReloadBaseline({ runtimeApplied: false });
      application?.settle("failed");
      return completeApplication();
    }
    const plan = buildGatewayReloadPlan(changedPaths, {
      noopPaths: [...configInstallMetadata.noopPaths, ...installMetadata.noopPaths],
      forceChangedPaths: [
        ...configInstallMetadata.forceChangedPaths,
        ...installMetadata.forceChangedPaths,
      ],
      candidateConfig: nextConfig,
      candidateCompareConfig: nextCompareConfig,
      previousCompareConfig: currentCompareConfig,
      previousConfig: currentConfig,
    });
    if (pluginLifecycle) {
      plan.pluginLifecycle = pluginLifecycle;
      plan.reloadPlugins = true;
      const unrelatedRestart = plan.restartReasons.find(
        (path) => path !== "plugins" && !path.startsWith("plugins."),
      );
      if (unrelatedRestart) {
        throw new Error(
          `Cannot apply plugin change while ${unrelatedRestart} requires a Gateway restart.`,
        );
      }
      plan.restartGateway = false;
      plan.restartReasons = [];
    }
    if (nextSettings.mode === "off" && !pluginLifecycle) {
      opts.log.info("config reload disabled (gateway.reload.mode=off)");
      await commitReloadBaseline({ runtimeApplied: false });
      application?.settle("failed");
      return completeApplication();
    }
    if (followUp.requiresRestart) {
      plan.restartGateway = true;
      plan.restartReasons.push(followUp.reason);
    }
    if (plan.restartGateway) {
      await opts.onConfigChange?.(plan, nextConfig);
      await prepareRestart(plan, nextConfig, ownership, nextSourceConfig);
      await commitReloadBaseline();
      // The accepted restart owns snapshot republication at next startup.
      application?.settle("restart-pending");
      return completeApplication();
    }

    // No-op plans also publish the runtime snapshot before its applied receipt.
    const applyRuntime = isNoopGatewayReloadPlan(plan) ? opts.onNoopConfigCommit : opts.onHotReload;
    await opts.onConfigChange?.(plan, nextConfig);
    let applicationStatus: void | GatewayHotReloadApplication;
    try {
      applicationStatus = await applyRuntime(plan, nextConfig, ownership, nextSourceConfig);
    } catch (error) {
      ownership.rollbackRuntimeEnv();
      throw error;
    }
    await checkpoint();
    assertCurrent();
    await appliedRevision.apply(plan, nextConfig, nextConfigRevisionHash);
    await commitReloadBaseline();
    settleRuntimeApplication(applicationStatus ?? "applied");
    const runtime =
      typeof applicationStatus === "object" && applicationStatus.status === "applied"
        ? applicationStatus.runtime
        : undefined;
    if (runtime) {
      completedPluginApplication = {
        runtime,
        snapshot: sourceSnapshot,
        installRecords: nextPluginInstallRecords,
      };
    }
    return completeApplication(runtime);
  };

  const promoteAcceptedSnapshot = async (snapshot: ConfigFileSnapshot, reason: string) => {
    if (!opts.promoteSnapshot || !snapshot.exists || !snapshot.valid) {
      return;
    }
    try {
      await opts.promoteSnapshot(snapshot, reason);
    } catch (err) {
      opts.log.warn(`config reload last-known-good promotion failed: ${String(err)}`);
    }
  };

  const runAcceptedTransaction = async (
    run: () => Promise<void>,
    application?: RuntimeConfigWriteApplicationClaim,
  ) => {
    const runTransaction = application?.runTransaction ?? opts.runTransaction;
    await (runTransaction ? runTransaction(run) : run());
  };

  const acceptCurrentRuntimeEcho = async (
    transactionEpoch: number,
    snapshot: ConfigFileSnapshot,
    runtimeApplied: boolean,
    assertLeaseOwned: () => void,
  ) => {
    const runtimeRefresh = runtimeApplied ? currentRuntimeRefresh : lastSourceOnlyRuntimeRefresh;
    const checkpointOwned = async (assertOwned: () => void) => {
      if (stopped || sourceObservation.epoch !== transactionEpoch) {
        throw new GatewayConfigReloadSupersededError();
      }
      assertOwned();
    };
    const ownership: GatewayConfigReloadTransactionOwnership = {
      isCurrent: () => !stopped && sourceObservation.epoch === transactionEpoch,
      checkpoint: () => checkpointOwned(assertLeaseOwned),
      withRestartPreparation: (run) => withRestartPreparation(ownership, checkpointOwned, run),
      reapplyRuntimeOverlays: runtimeApplied
        ? currentReapplyRuntimeOverlays
        : (lastSourceOnlyReapplyRuntimeOverlays ?? currentReapplyRuntimeOverlays),
      publishRuntimeEnv: () => {},
      rollbackRuntimeEnv: () => {},
      commitRuntimeEnv: () => {},
      ...(runtimeRefresh ? { runtimeRefresh } : {}),
      markRuntimeCommitted: () => {},
    };
    await runAcceptedTransaction(async () => {
      await appliedRevision.flush(currentConfig);
      assertLeaseOwned();
      if (!ownership.isCurrent()) {
        throw new GatewayConfigReloadSupersededError();
      }
      await opts.onConfigAccepted?.(
        runtimeApplied ? currentConfig : (lastSourceOnlyRuntimeConfig ?? currentConfig),
        ownership,
        runtimeApplied ? currentSourceConfig : (lastSourceOnlySourceConfig ?? currentSourceConfig),
        { runtimeApplied },
      );
      assertLeaseOwned();
      if (!ownership.isCurrent()) {
        throw new GatewayConfigReloadSupersededError();
      }
      if (snapshot.valid && typeof snapshot.hash === "string") {
        updateAcceptedSnapshot(hashConfigRaw(snapshot.raw), snapshot.parsed);
      }
    });
    if (snapshot.valid) {
      await acceptWatchedPaths(snapshot.includedPaths ?? []);
    }
  };

  const applyWrittenSnapshot = async (
    snapshot: ConfigFileSnapshot,
    candidate: InProcessConfigCandidate,
    epoch: number,
    assertLeaseOwned: () => void,
  ) => {
    const applied = await applySnapshot(snapshot, candidate, epoch, {
      assertInvokerOwned: assertLeaseOwned,
    });
    if (activeInProcessConfig === candidate) {
      activeInProcessConfig = null;
    }
    if (watcherIntentCandidate === candidate) {
      watcherIntentCandidate = null;
      watcherIntentCameFromPendingWrite = false;
    }
    await acceptWatchedPaths(snapshot.includedPaths ?? []);
    if (applied.isCurrent()) {
      await promoteAcceptedSnapshot(snapshot, "in-process-write");
    }
  };

  const runReload = async (assertLeaseOwned: () => void) => {
    if (stopped || !initialized) {
      return;
    }
    if (running) {
      pending = true;
      return;
    }
    running = true;
    pending = false;
    clearReloadTimer();
    let attemptedCandidate: InProcessConfigCandidate | null = null;
    try {
      assertLeaseOwned();
      if (pendingInProcessConfig) {
        const pendingWrite = pendingInProcessConfig;
        attemptedCandidate = pendingWrite;
        pendingInProcessConfig = null;
        activeInProcessConfig = pendingWrite;
        missingConfigRetries = 0;
        try {
          await runAcceptedTransaction(async () => {
            const snapshot = await opts.readSnapshot(currentRuntimeEnvSourceConfig);
            assertLeaseOwned();
            if (
              !snapshot.exists ||
              !snapshot.valid ||
              sourceObservation.writerEpoch > pendingWrite.epoch ||
              activeInProcessConfig !== pendingWrite ||
              snapshot.hash !== pendingWrite.persistedHash ||
              diffConfigPaths(snapshot.sourceConfig, pendingWrite.compareConfig).length > 0
            ) {
              throw new GatewayConfigReloadSupersededError();
            }
            await applyWrittenSnapshot(
              snapshot,
              pendingWrite,
              pendingWrite.epoch,
              assertLeaseOwned,
            );
          }, pendingWrite.application);
        } catch (err) {
          if (lastAppliedWriteHash === pendingWrite.persistedHash) {
            lastAppliedWriteHash = null;
          }
          if (
            sourceObservation.epoch === pendingWrite.epoch &&
            !pendingInProcessConfig &&
            !watcherIntentCandidate
          ) {
            watcherIntentCandidate = pendingWrite;
            watcherIntentCameFromPendingWrite = false;
          }
          throw err;
        } finally {
          if (activeInProcessConfig === pendingWrite) {
            activeInProcessConfig = null;
          }
        }
        return;
      }
      const transactionEpoch = sourceObservation.epoch;
      const intentCandidate = watcherIntentCandidate;
      attemptedCandidate = intentCandidate;
      const intentCandidateCameFromPendingWrite = watcherIntentCameFromPendingWrite;
      const snapshot = await opts.readSnapshot(currentRuntimeEnvSourceConfig);
      assertLeaseOwned();
      if (sourceObservation.epoch !== transactionEpoch) {
        throw new GatewayConfigReloadSupersededError();
      }
      const missingRetriesExhausted =
        !snapshot.exists && missingConfigRetries >= MISSING_CONFIG_MAX_RETRIES;
      if (handleMissingSnapshot(snapshot)) {
        if (missingRetriesExhausted) {
          settleApplication(intentCandidate, "failed");
        }
        await appliedRevision.flush(currentConfig);
        return;
      }
      await observeCandidateWatchedPaths(snapshot.includedPaths ?? []);
      assertLeaseOwned();
      const observedRawHash = hashConfigRaw(snapshot.raw);
      const previousObservedRawHash = lastObservedRawHash;
      const newObservedRawHash = observedRawHash !== previousObservedRawHash;
      lastObservedRawHash = observedRawHash;
      if (startupInternalWriteHash && typeof snapshot.hash === "string") {
        const matchesStartupWrite =
          snapshot.valid &&
          snapshot.hash === startupInternalWriteHash &&
          diffConfigPaths(currentSourceConfig, snapshot.sourceConfig).length === 0;
        // This hash comes from the startup write itself. Consume only its
        // first source-identical watcher echo; includes can change under it.
        startupInternalWriteHash = null;
        if (matchesStartupWrite) {
          await acceptCurrentRuntimeEcho(transactionEpoch, snapshot, true, assertLeaseOwned);
          return;
        }
      }
      if (
        intentCandidate &&
        snapshot.valid &&
        snapshot.hash === intentCandidate.persistedHash &&
        diffConfigPaths(intentCandidate.compareConfig, snapshot.sourceConfig).length === 0
      ) {
        lastAppliedWriteHash = intentCandidate.persistedHash;
        try {
          await runAcceptedTransaction(async () => {
            await applyWrittenSnapshot(
              snapshot,
              intentCandidate,
              transactionEpoch,
              assertLeaseOwned,
            );
          }, intentCandidate.application);
        } catch (err) {
          if (lastAppliedWriteHash === intentCandidate.persistedHash) {
            lastAppliedWriteHash = null;
          }
          if (sourceObservation.epoch === transactionEpoch && !watcherIntentCandidate) {
            watcherIntentCandidate = intentCandidate;
            watcherIntentCameFromPendingWrite = intentCandidateCameFromPendingWrite;
          }
          throw err;
        }
        return;
      }
      if (watcherIntentCandidate === intentCandidate) {
        settleApplication(intentCandidate, "superseded");
        watcherIntentCandidate = null;
        watcherIntentCameFromPendingWrite = false;
      }
      if (intentCandidate && lastAppliedWriteHash === intentCandidate.persistedHash) {
        lastAppliedWriteHash = null;
      }
      if (lastAppliedWriteHash && typeof snapshot.hash === "string") {
        const matchesAcceptedEffectiveConfig =
          snapshot.valid &&
          snapshot.hash === lastAppliedWriteHash &&
          diffConfigPaths(currentSourceConfig, snapshot.sourceConfig).length === 0;
        if (matchesAcceptedEffectiveConfig) {
          await acceptCurrentRuntimeEcho(
            transactionEpoch,
            snapshot,
            snapshot.hash !== lastSourceOnlyWriteHash,
            assertLeaseOwned,
          );
          return;
        }
        lastAppliedWriteHash = null;
      }
      if (!snapshot.valid) {
        if (newObservedRawHash) {
          appendExternalAudit({
            detectedBy: "watch",
            previousHash: previousObservedRawHash,
            nextHash: observedRawHash,
            valid: false,
            issues: capConfigAuditIssues(
              formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }),
            ),
          });
        }
        const issues = formatConfigIssueLines(snapshot.issues, "").join(", ");
        opts.log.warn(`config reload skipped (invalid config): ${issues}`);
        await appliedRevision.flush(currentConfig);
        return;
      }
      const nextRawHash = observedRawHash;
      const externalChangedPaths = diffConfigPaths(currentSourceConfig, snapshot.sourceConfig);
      const fingerprintedAuthoredChangedPaths = diffConfigPaths(
        currentFingerprintedAuthoredConfig,
        fingerprintConfigSnapshotAuthoredConfig(snapshot.parsed, { env: process.env, homedir }),
      );
      const journalChangedPaths = [
        ...new Set([...externalChangedPaths, ...fingerprintedAuthoredChangedPaths]),
      ];
      const matchingWriterSlot = readConfigSnapshotAuditRecord({ configPath: opts.watchPath });
      if (
        newObservedRawHash &&
        (nextRawHash === currentRawHash || matchingWriterSlot?.rawHash !== nextRawHash)
      ) {
        // Returning to accepted bytes after a rejected edit is still an observed transition.
        // A slot upsert can race awaitWriteFinish; the rare duplicate still carries exact hashes.
        appendExternalAudit({
          detectedBy: "watch",
          previousHash: previousObservedRawHash,
          nextHash: nextRawHash,
          valid: true,
          ...(journalChangedPaths.length > 0
            ? { changedPaths: capConfigAuditPaths(journalChangedPaths) }
            : {}),
          // No config-path diff means the raw edit was comments or formatting only.
          ...(journalChangedPaths.length === 0 ? { opaqueChange: true } : {}),
        });
      }
      await runAcceptedTransaction(async () => {
        const applied = await applySnapshot(snapshot, undefined, transactionEpoch, {
          assertInvokerOwned: assertLeaseOwned,
        });
        if (applied.isCurrent()) {
          await promoteAcceptedSnapshot(snapshot, "valid-config");
        }
      });
      await acceptWatchedPaths(snapshot.includedPaths ?? []);
    } catch (err) {
      const superseded = isConfigReloadSuperseded(err);
      const transferredToWatcher =
        superseded && attemptedCandidate !== null && watcherIntentCandidate === attemptedCandidate;
      if (!transferredToWatcher) {
        settleApplication(attemptedCandidate, superseded ? "superseded" : "failed");
      }
      if (superseded) {
        opts.log.info(`config reload superseded: ${String(err)}`);
      } else {
        opts.log.error(`config reload failed: ${String(err)}`);
      }
    } finally {
      running = false;
    }
  };

  function trackReload(reload: Promise<void>): void {
    activeReloads.add(reload);
    void reload.then(
      () => activeReloads.delete(reload),
      () => activeReloads.delete(reload),
    );
  }

  function startTrackedReload(): void {
    if (running || watcherReload) {
      pending = true;
      return;
    }
    // Management enters with the lease held, then takes the config queue. A watcher
    // must use the same order, including when its timer inherited a writer's context.
    const reload = runOutsidePluginLifecycleLease(() =>
      withPluginLifecycleLease({ signal: lifecycle.signal }, async (lease) => {
        await runReload(() => lease.assertOwned());
      }),
    ).catch((error: unknown) => {
      if (!stopped) {
        opts.log.error(`config reload failed: ${String(error)}`);
      }
    });
    watcherReload = reload;
    activeReloadCompletion = reload;
    activeReloads.add(reload);
    void reload.then(() => {
      activeReloads.delete(reload);
      watcherReload = undefined;
      if (pending && !running) {
        pending = false;
        schedule();
      }
    });
  }

  const applyPluginLifecycleChange: PluginLifecycleRuntimeApply = (params) => {
    const previousOperation = pluginOperationTail;
    const operationId = randomUUID();
    const operation: Promise<PluginRuntimeApplication> = previousOperation.then(async () => {
      params.assertInvokerOwned?.();
      await ready;
      params.assertInvokerOwned?.();
      // The awaited reload releases `running` in finally; a queued reload may take ownership next.
      for (;;) {
        if (!running) {
          break;
        }
        await activeReloadCompletion;
      }
      params.assertInvokerOwned?.();
      if (stopped) {
        throw new Error("Gateway plugin lifecycle is stopped.");
      }
      running = true;
      activeReloadCompletion = operation;
      clearReloadTimer();
      let candidate = pendingInProcessConfig ?? watcherIntentCandidate;
      let committed = false;
      try {
        const expectedSourceConfig = params.write
          ? params.write.persistedSourceConfig
          : params.config;
        const epoch = sourceObservation.epoch;
        const snapshot = await opts.readSnapshot(currentRuntimeEnvSourceConfig);
        params.assertInvokerOwned?.();
        if (!snapshot.valid || !snapshot.exists) {
          throw new Error("Plugin runtime application requires a valid persisted config.");
        }
        if (
          !expectedSourceConfig ||
          (params.write &&
            (typeof params.write.persistedHash !== "string" ||
              snapshot.hash !== params.write.persistedHash)) ||
          diffConfigPaths(snapshot.sourceConfig, expectedSourceConfig).length > 0
        ) {
          throw new GatewayConfigReloadSupersededError();
        }
        if (pendingInProcessConfig === candidate) {
          pendingInProcessConfig = null;
        }
        activeInProcessConfig = candidate;
        if (sourceObservation.writerEpoch > epoch) {
          throw new GatewayConfigReloadSupersededError();
        }
        const matchesSnapshot = (queued: typeof candidate) =>
          queued !== null &&
          snapshot.hash === queued.persistedHash &&
          diffConfigPaths(snapshot.sourceConfig, queued.compareConfig).length === 0;
        if (!matchesSnapshot(candidate)) {
          if (candidate !== watcherIntentCandidate) {
            settleApplication(candidate, "superseded");
          }
          candidate = matchesSnapshot(watcherIntentCandidate) ? watcherIntentCandidate : null;
        }
        if (watcherIntentCandidate && watcherIntentCandidate !== candidate) {
          settleApplication(watcherIntentCandidate, "superseded");
          watcherIntentCandidate = null;
          watcherIntentCameFromPendingWrite = false;
        }
        activeInProcessConfig = candidate;
        // Keep the invoking admission so plugin drain excludes the request
        // awaiting this receipt. Watcher echoes may transfer only this write.
        const applied = await applySnapshot(snapshot, candidate, epoch, {
          pluginLifecycle: {
            pluginIds: params.pluginIds,
            reason: params.reason,
            operationId,
            expectedSourceDigests: params.expectedSourceDigests,
            expectedInstallHashes: params.expectedInstallHashes,
          },
          onRuntimeCommitted: () => {
            committed = true;
          },
          assertInvokerOwned: params.assertInvokerOwned,
        });
        if (!applied.runtime) {
          throw new Error("Plugin runtime application did not produce a completed receipt.");
        }
        if (watcherIntentCandidate === candidate) {
          watcherIntentCandidate = null;
          watcherIntentCameFromPendingWrite = false;
        }
        lastAppliedWriteHash = snapshot.hash ?? null;
        await acceptWatchedPaths(snapshot.includedPaths ?? []);
        if (applied.isCurrent()) {
          await promoteAcceptedSnapshot(snapshot, "plugin-lifecycle");
        }
        return applied.runtime;
      } catch (error) {
        settleApplication(candidate, "failed");
        if (error instanceof PluginRuntimeApplicationError) {
          throw error;
        }
        throw new PluginRuntimeApplicationError(
          String(error),
          {
            operationId,
            generation: getPluginRuntimeGeneration(),
            pluginIds: [...params.pluginIds],
            phase: "prepare",
            committed,
          },
          { cause: error },
        );
      } finally {
        if (activeInProcessConfig === candidate) {
          activeInProcessConfig = null;
        }
        running = false;
        if (pending || pendingInProcessConfig) {
          pending = false;
          schedule();
        }
      }
    });
    pluginOperationTail = operation.catch(() => {});
    activeReloads.add(operation);
    void operation.then(
      () => activeReloads.delete(operation),
      () => activeReloads.delete(operation),
    );
    return operation;
  };

  const scheduleExternalRefresh = () => {
    opts.onConfigCandidateObserved?.();
    // Fence publication until this observation validates. A genuine successor
    // belongs to the scheduled watcher, never the preceding transaction.
    sourceObservation = {
      epoch: sourceObservation.epoch + 1,
      writerEpoch: sourceObservation.writerEpoch,
    };
    const pendingCandidate = pendingInProcessConfig;
    const activeCandidate = activeInProcessConfig;
    const newestLiveCandidate =
      pendingCandidate && (!activeCandidate || pendingCandidate.epoch > activeCandidate.epoch)
        ? pendingCandidate
        : activeCandidate;
    if (
      newestLiveCandidate &&
      (!watcherIntentCandidate || newestLiveCandidate.epoch > watcherIntentCandidate.epoch)
    ) {
      if (watcherIntentCandidate !== newestLiveCandidate) {
        settleApplication(watcherIntentCandidate, "superseded");
      }
      watcherIntentCandidate = newestLiveCandidate;
      watcherIntentCameFromPendingWrite = newestLiveCandidate === pendingCandidate;
    }
    if (pendingInProcessConfig) {
      pendingInProcessConfig = null;
    }
    schedule();
  };

  const unsubscribeFromWrites =
    opts.subscribeToWrites?.((event) => {
      if (event.configPath !== opts.watchPath) {
        return;
      }
      const application = getRuntimeConfigWriteApplication(event)?.claim();
      if (stopped) {
        application?.settle("stopped");
        return;
      }
      // A live writer notification owns any following watcher echo. Do not
      // let the startup token discard its intent or prepared runtime metadata.
      startupInternalWriteHash = null;
      opts.onConfigCandidateObserved?.();
      sourceObservation = {
        epoch: sourceObservation.epoch + 1,
        writerEpoch: sourceObservation.epoch + 1,
      };
      const pendingRestartIntent =
        pendingInProcessConfig?.afterWrite?.mode === "restart"
          ? pendingInProcessConfig.afterWrite
          : watcherIntentCameFromPendingWrite &&
              watcherIntentCandidate?.afterWrite?.mode === "restart"
            ? watcherIntentCandidate.afterWrite
            : undefined;
      settleApplication(pendingInProcessConfig, "superseded");
      settleApplication(watcherIntentCandidate, "superseded");
      watcherIntentCandidate = null;
      watcherIntentCameFromPendingWrite = false;
      // Pending writes coalesce to the latest config, but a newer non-restart intent
      // must not erase a restart already required by an unapplied committed write,
      // including one moved into watcher ownership by its filesystem echo.
      const afterWrite =
        pendingRestartIntent && event.afterWrite?.mode !== "restart"
          ? pendingRestartIntent
          : event.afterWrite;
      pendingInProcessConfig = {
        config: event.runtimeConfig,
        compareConfig: event.sourceConfig,
        persistedHash: event.persistedHash,
        afterWrite,
        ...(event.preparedCandidate ? { preparedCandidate: event.preparedCandidate } : {}),
        ...(event.runtimeRefresh ? { runtimeRefresh: event.runtimeRefresh } : {}),
        ...(application ? { application } : {}),
        epoch: sourceObservation.epoch,
      };
      lastAppliedWriteHash = event.persistedHash;
      scheduleAfter(0);
    }) ?? (() => {});

  let watcher: ReturnType<typeof chokidar.watch> | null = null;
  const acceptedIncludedPaths = new Set(opts.initialIncludedPaths ?? []);
  let candidateIncludedPaths = new Set<string>();
  const watchedPaths = new Set([opts.watchPath, ...acceptedIncludedPaths]);
  let watcherRecreateRetries = 0;
  let watcherRecreateTimer: ReturnType<typeof setTimeout> | null = null;
  let hotReloadStatus: GatewayHotReloadStatus = "active";
  let degradedToPolling = false;
  let watcherUsesPolling = false;

  const reconcileInitialWatch = async (source: NonNullable<typeof watcher>) => {
    const epoch = sourceObservation.epoch;
    const isCurrent = () => !stopped && watcher === source && sourceObservation.epoch === epoch;
    try {
      const snapshot = await opts.readSnapshot(currentRuntimeEnvSourceConfig);
      if (!isCurrent()) {
        return;
      }
      const includedPaths = snapshot.includedPaths ?? [];
      const hasIncludes = acceptedIncludedPaths.size > 0 || includedPaths.length > 0;
      const sameIncludedPaths =
        acceptedIncludedPaths.size === includedPaths.length &&
        includedPaths.every((path) => acceptedIncludedPaths.has(path));
      const sameRoot = snapshot.exists
        ? hashConfigRaw(snapshot.raw) === currentRawHash
        : currentRawHash === null;
      // Without includes, equal authored bytes prove the initial scan found no disk edit.
      // Included files can change without changing the root file hash.
      if (
        snapshot.valid &&
        sameRoot &&
        (!hasIncludes ||
          (sameIncludedPaths &&
            diffConfigPaths(currentSourceConfig, snapshot.sourceConfig).length === 0))
      ) {
        return;
      }
    } catch (err) {
      if (!isCurrent()) {
        return;
      }
      opts.log.warn(`config reload initial watch check failed: ${String(err)}`);
    }
    scheduleExternalRefresh();
  };

  const createWatcher = (reconcileAfterReady?: "initial" | "replacement") => {
    if (stopped) {
      return;
    }
    const usePolling = resolveChokidarUsePolling(degradedToPolling);
    const next = chokidar.watch([...watchedPaths], {
      depth: 0,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      usePolling,
    });
    // A file event proves this watcher recovered. Reset only here so plugin
    // metadata refreshes and consecutive watcher errors cannot refill the budget.
    const scheduleFromWatcherEvent = (eventPath: string) => {
      if (!watchedPaths.has(nodePath.normalize(eventPath))) {
        return;
      }
      watcherRecreateRetries = 0;
      scheduleExternalRefresh();
    };
    next.on("add", scheduleFromWatcherEvent);
    next.on("change", scheduleFromWatcherEvent);
    next.on("unlink", scheduleFromWatcherEvent);
    next.on("error", (err) => {
      handleWatcherError(next, err);
    });
    next.on("ready", () => {
      opts.onWatcherReady?.();
      if (reconcileAfterReady) {
        // Initial add events are suppressed. Reconcile after the scan, ignoring a
        // watcher that was replaced or stopped before reaching ready.
        if (!stopped && watcher === next) {
          if (reconcileAfterReady === "initial") {
            trackReload(reconcileInitialWatch(next));
          } else {
            scheduleExternalRefresh();
          }
        }
      }
    });
    watcher = next;
    watcherUsesPolling = next.options.usePolling;
    hotReloadStatus = "active";
  };

  const handleWatcherError = (source: typeof watcher, err: unknown) => {
    // Ignore stale errors from a watcher we already replaced or stopped.
    if (stopped || source !== watcher) {
      return;
    }
    const failedWatcherUsedPolling = watcherUsesPolling;
    watcher = null;
    watcherUsesPolling = false;
    void source?.close().catch(() => {});
    if (watcherRecreateRetries >= WATCHER_RECREATE_MAX_RETRIES) {
      // All native (inotify/kqueue) retries exhausted — fall back to polling
      // mode so config hot-reload survives on hosts where inotify resources
      // are constrained (e.g. low fs.inotify.max_user_watches).
      if (!failedWatcherUsedPolling && resolveChokidarUsePolling(true)) {
        degradedToPolling = true;
        watcherRecreateRetries = 0;
        opts.log.warn(
          `config watcher native retries exhausted; degrading to polling mode: ${String(err)}`,
        );
        watcherRecreateTimer = setTimeout(() => {
          watcherRecreateTimer = null;
          createWatcher("replacement");
        }, WATCHER_RECREATE_BACKOFF_MS[0] ?? 500);
        return;
      }
      const mode = failedWatcherUsedPolling ? "polling mode" : "native mode";
      hotReloadStatus = "disabled";
      opts.log.error(
        `config hot-reload disabled: watcher failed after ${WATCHER_RECREATE_MAX_RETRIES} re-create attempts in ${mode}: ${String(err)}`,
      );
      return;
    }
    const backoff =
      WATCHER_RECREATE_BACKOFF_MS[watcherRecreateRetries] ??
      WATCHER_RECREATE_BACKOFF_MS[WATCHER_RECREATE_BACKOFF_MS.length - 1] ??
      0;
    watcherRecreateRetries += 1;
    opts.log.warn(
      `config watcher error; re-creating watcher (attempt ${watcherRecreateRetries}/${WATCHER_RECREATE_MAX_RETRIES} in ${backoff}ms): ${String(err)}`,
    );
    watcherRecreateTimer = setTimeout(() => {
      watcherRecreateTimer = null;
      createWatcher("replacement");
    }, backoff);
  };

  const reconcileWatchedPaths = async (includedPaths: readonly string[]) => {
    const nextPaths = new Set([opts.watchPath, ...includedPaths]);
    const additions = [...nextPaths].filter((candidate) => !watchedPaths.has(candidate));
    const removals = [...watchedPaths].filter((candidate) => !nextPaths.has(candidate));
    if (additions.length === 0 && removals.length === 0) {
      return;
    }

    watchedPaths.clear();
    for (const candidate of nextPaths) {
      watchedPaths.add(candidate);
    }
    const activeWatcher = watcher;
    if (!activeWatcher) {
      return;
    }
    try {
      await activeWatcher.close();
    } catch (err) {
      handleWatcherError(activeWatcher, err);
      return;
    }
    if (stopped || watcher !== activeWatcher) {
      return;
    }
    watcher = null;
    watcherUsesPolling = false;
    createWatcher("replacement");
  };

  const observeCandidateWatchedPaths = async (includedPaths: readonly string[]) => {
    candidateIncludedPaths = new Set(includedPaths);
    await reconcileWatchedPaths([...acceptedIncludedPaths, ...candidateIncludedPaths]);
  };

  const acceptWatchedPaths = async (includedPaths: readonly string[]) => {
    acceptedIncludedPaths.clear();
    for (const candidate of includedPaths) {
      acceptedIncludedPaths.add(candidate);
    }
    candidateIncludedPaths.clear();
    await reconcileWatchedPaths([...acceptedIncludedPaths]);
  };

  const ready = (async () => {
    const initialCandidate = opts.prepareConfigCandidate
      ? await opts.prepareConfigCandidate({
          runtimeConfig: opts.initialConfig,
          sourceConfig: initialSourceConfig,
          previousSourceConfig: initialSourceConfig,
        })
      : undefined;
    const initialPluginInstallRecords =
      opts.initialPluginInstallRecords ?? (await readCurrentInstallRecords());
    if (stopped) {
      throw new GatewayConfigReloadSupersededError();
    }
    currentConfig = initialCandidate?.runtimeConfig ?? opts.initialConfig;
    currentCompareConfig = initialCandidate?.compareConfig ?? initialSourceConfig;
    currentReapplyRuntimeOverlays =
      initialCandidate?.reapplyRuntimeOverlays ?? ((config) => config);
    settings = resolveSettings(currentConfig);
    opts.onReloadEnabledChange?.(settings.mode !== "off");
    currentSnapshotSlot = readLatestConfigSnapshotAuditRecord();
    // A write captured during validation owns the newer audit baseline.
    if (sourceObservation.epoch === 0) {
      const priorSnapshot = configSnapshotAuditRecordMatchesPath(
        currentSnapshotSlot,
        opts.watchPath,
      )
        ? currentSnapshotSlot
        : null;
      if (priorSnapshot && opts.initialSnapshotRawHash === null) {
        currentRawHash = priorSnapshot.rawHash;
        currentFingerprintedAuthoredConfig = priorSnapshot.fingerprintedAuthoredConfig;
        appendExternalAudit({
          detectedBy: "startup",
          previousHash: priorSnapshot.rawHash,
          nextHash: null,
          valid: false,
          issues: capConfigAuditIssues(["config file missing"]),
        });
      } else if (priorSnapshot && priorSnapshot.rawHash !== opts.initialSnapshotRawHash) {
        if (!opts.initialSnapshotValid) {
          currentRawHash = priorSnapshot.rawHash;
          currentFingerprintedAuthoredConfig = priorSnapshot.fingerprintedAuthoredConfig;
        }
        const startupChangedPaths = opts.initialSnapshotValid
          ? diffConfigPaths(
              priorSnapshot.fingerprintedAuthoredConfig,
              fingerprintConfigSnapshotAuthoredConfig(opts.initialAuthoredConfig, {
                env: process.env,
                homedir,
              }),
            )
          : [];
        appendExternalAudit({
          detectedBy: "startup",
          previousHash: priorSnapshot.rawHash,
          nextHash: opts.initialSnapshotRawHash,
          valid: opts.initialSnapshotValid,
          ...(!opts.initialSnapshotValid
            ? {
                issues: capConfigAuditIssues(
                  formatConfigIssueLines(opts.initialSnapshotIssues, "", { normalizeRoot: true }),
                ),
              }
            : startupChangedPaths.length > 0
              ? { changedPaths: capConfigAuditPaths(startupChangedPaths) }
              : { opaqueChange: true }),
        });
      }
      if (opts.initialSnapshotRawHash !== null && opts.initialSnapshotValid) {
        updateAcceptedSnapshot(opts.initialSnapshotRawHash, opts.initialAuthoredConfig);
      }
    }
    currentPluginInstallRecords = initialPluginInstallRecords;
    // Async preparation can outlive disk changes before the initial watch scan.
    createWatcher(
      opts.prepareConfigCandidate !== undefined || opts.initialPluginInstallRecords === undefined
        ? "initial"
        : undefined,
    );
    initialized = true;
    if (pendingInProcessConfig || pending) {
      scheduleAfter(0);
    }
  })();

  return {
    ready,
    isReady: () => initialized,
    applyPluginLifecycleChange,
    isReloading: () => activeReloads.size > 0,
    stop: async () => {
      stopped = true;
      lifecycle.abort(new GatewayConfigReloadSupersededError());
      settleApplication(pendingInProcessConfig, "stopped");
      settleApplication(activeInProcessConfig, "stopped");
      settleApplication(watcherIntentCandidate, "stopped");
      clearReloadTimer();
      if (watcherRecreateTimer) {
        clearTimeout(watcherRecreateTimer);
        watcherRecreateTimer = null;
      }
      unsubscribeFromWrites();
      await ready.catch(() => {});
      const active = watcher;
      watcher = null;
      await active?.close().catch(() => {});
      // Timer callbacks detach runReload; shutdown owns their full transaction unwind.
      await Promise.all(activeReloads);
    },
    hotReloadStatus: () => (initialized ? hotReloadStatus : undefined),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
