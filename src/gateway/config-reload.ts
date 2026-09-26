import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { runOutsideSetupCredentialAccess } from "../agents/auth-profiles/setup-access.js";
import type { ConfigRuntimeEnvPublication } from "../config/config-env-vars.js";
import {
  configSnapshotAuditRecordMatchesPath,
  fingerprintConfigSnapshotAuthoredConfig,
  readLatestConfigSnapshotAuditRecordAsync,
  upsertConfigSnapshotAuditRecordAsync,
} from "../config/config-journal-snapshot.js";
import {
  appendConfigAuditRecord,
  capConfigAuditIssues,
  capConfigAuditPaths,
  type ConfigExternalChangeAuditRecord,
} from "../config/io.audit.js";
import type { ConfigWriteNotification } from "../config/io.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { hashRuntimeConfigValue, resolveConfigWriteFollowUp } from "../config/runtime-snapshot.js";
import type { RuntimeConfigSnapshotRefreshOptions } from "../config/runtime-snapshot.js";
import {
  getRuntimeConfigWriteApplication,
  type RuntimeConfigWriteApplicationClaim,
  type RuntimeConfigWriteApplicationStatus,
} from "../config/runtime-write-application.js";
import {
  createConfigSource,
  configSourceSnapshotsMatch,
  type ConfigSourceObservation,
} from "../config/source.js";
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
  GatewayConfigReloader,
  GatewayHotReloadApplication,
} from "./config-reload-status.types.js";
import {
  assertReloadPublicationCurrent,
  GatewayConfigReloadSupersededError,
} from "./server-reload-contracts.js";

export type { GatewayReloadPlan } from "./config-reload-plan.js";
const MISSING_CONFIG_RETRY_DELAY_MS = 150;
const MISSING_CONFIG_MAX_RETRIES = 2;

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
  snapshot: ConfigFileSnapshot;
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
      publishSource?: () => Promise<void>;
    },
  ) => void | Promise<void>;
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
  const resolveSettings = (config: OpenClawConfig) =>
    resolveGatewayReloadSettings(config, opts.testDebounceMs);
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
  let pluginOperationTail: Promise<unknown> = Promise.resolve();
  let missingConfigRetries = 0;
  const observationReads = new WeakMap<
    ConfigSourceObservation,
    Promise<[ConfigFileSnapshot, PluginInstallRecords]>
  >();
  let pendingInProcessConfig: InProcessConfigCandidate | null = null;
  let activeInProcessConfig: InProcessConfigCandidate | null = null;
  let retryWriteCandidate: InProcessConfigCandidate | null = null;
  const settleApplication = (
    candidate: InProcessConfigCandidate | null,
    status: RuntimeConfigWriteApplicationStatus,
  ) => {
    candidate?.application?.settle(status);
  };
  let acceptedSourceSnapshot: ConfigFileSnapshot | undefined;
  let lastSourceOnly:
    | {
        hash: string | null;
        config: OpenClawConfig;
        sourceConfig: OpenClawConfig;
        reapplyRuntimeOverlays: GatewayConfigReloadTransactionOwnership["reapplyRuntimeOverlays"];
        runtimeRefresh?: RuntimeConfigSnapshotRefreshOptions;
      }
    | undefined;

  const assertSourceLive = () => {
    if (stopped) {
      throw new GatewayConfigReloadSupersededError();
    }
  };
  const appendExternalAudit = async (
    record: Omit<ConfigExternalChangeAuditRecord, "ts" | "source" | "event" | "configPath">,
  ) => {
    await appendConfigAuditRecord({
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
  let currentSnapshotSlot: Awaited<ReturnType<typeof readLatestConfigSnapshotAuditRecordAsync>> =
    null;

  const updateAcceptedSnapshot = async (rawHash: string, authoredConfig: unknown) => {
    const fingerprinted = fingerprintConfigSnapshotAuthoredConfig(authoredConfig, {
      env: process.env,
      homedir,
    });
    const updatedSlot = await upsertConfigSnapshotAuditRecordAsync(
      {
        configPath: opts.watchPath,
        rawHash,
        authoredConfig,
        expectedSnapshot: currentSnapshotSlot,
      },
      assertSourceLive,
    );
    currentRawHash = rawHash;
    currentFingerprintedAuthoredConfig = fingerprinted;
    if (updatedSlot) {
      currentSnapshotSlot = updatedSlot;
      return;
    }
    currentSnapshotSlot = await readLatestConfigSnapshotAuditRecordAsync(
      undefined,
      assertSourceLive,
    );
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
    scheduleAfter(pendingInProcessConfig ? 0 : settings.debounceMs);
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
      source.observe();
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
    initialEpoch = source.observation.revision,
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
    const isCurrent = () =>
      !stopped && !rejected && source.observation.revision === transactionEpoch;
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
      if (source.observation.revision !== transactionEpoch) {
        const observed = source.observation;
        if (observed.writerRevision > transactionEpoch) {
          throw new GatewayConfigReloadSupersededError();
        }
        // Read under this observation, not the reload queue: the active transaction
        // owns that queue and may already have stopped its plugin services.
        let read = observationReads.get(observed);
        if (!read) {
          read = Promise.all([source.readSnapshot(observed), readPluginInstallRecords()]);
          observationReads.set(observed, read);
        }
        const [snapshot, installs] = await read;
        if (
          stopped ||
          source.observation !== observed ||
          !snapshot.exists ||
          !snapshot.valid ||
          typeof persistedHash !== "string" ||
          !configSourceSnapshotsMatch(snapshot, sourceSnapshot) ||
          !isDeepStrictEqual(installs, nextPluginInstallRecords)
        ) {
          throw new GatewayConfigReloadSupersededError();
        }
        assertOwned();
        transactionEpoch = observed.revision;
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
        source.accept(transactionEpoch);
      }
      return { runtime, isCurrent };
    };
    assertInvokerOwned();
    // A watcher can echo this operation's ledger change before the first checkpoint.
    // Compare it with the candidate records, not the previous runtime generation.
    try {
      nextPluginInstallRecords = await readPluginInstallRecords();
    } catch (err) {
      opts.log.warn(`config reload plugin install record check failed: ${String(err)}`);
    }
    await checkpoint();
    await application?.prepare?.(assertCurrent);
    await checkpoint();
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
    // Recheck the invoking admission after asynchronous preparation. The next
    // checkpoint reconciles watcher echoes against the captured install records.
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
        acceptedSourceSnapshot = undefined;
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
      configSourceSnapshotsMatch(sourceSnapshot, completed.snapshot) &&
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
    let publishedSource: { rollback: () => Promise<void>; commit?: () => void } | undefined;
    const publishSource =
      changedPaths.length === 0 && !pluginLifecycle && opts.onEffectiveConfigUnchanged
        ? async () => {
            publishedSource ??= await opts.onEffectiveConfigUnchanged!(
              nextConfig,
              ownership,
              nextSourceConfig,
            );
          }
        : undefined;
    const commitReloadBaseline = async (options: { runtimeApplied?: boolean } = {}) => {
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
        opts.log.info(
          `config source revision ${initialEpoch} accepted (${candidate ? "write" : "file"})`,
        );
        opts.onReloadEnabledChange?.(nextSettings.mode !== "off");
        if (changedPaths.length > 0) {
          opts.onConfigCandidateCommitted?.({
            path: opts.watchPath,
            persistedHash: persistedHash ?? null,
            changedPaths,
          });
        }
      };
      try {
        await opts.onConfigAccepted?.(
          committedRuntimeConfig ?? nextConfig,
          ownership,
          nextSourceConfig,
          {
            runtimeApplied: options.runtimeApplied !== false,
            ...(publishSource ? { publishSource } : {}),
          },
        );
        await checkpoint();
        assertCurrent();
        if (!publishedSource) {
          await publishSource?.();
        }
        await checkpoint();
        assertCurrent();
        await updateAcceptedSnapshot(hashConfigRaw(sourceSnapshot.raw), sourceSnapshot.parsed);
        await checkpoint();
        assertCurrent();
        currentSourceConfig = nextSourceConfig;
        acceptedSourceSnapshot = sourceSnapshot;
        if (options.runtimeApplied === false) {
          // Persisted-but-skipped candidates are not runtime truth. Keep the
          // effective baseline so a later safe edit cannot publish them indirectly.
          lastSourceOnly = {
            hash: persistedHash ?? null,
            config: nextConfig,
            sourceConfig: nextSourceConfig,
            reapplyRuntimeOverlays: ownership.reapplyRuntimeOverlays,
            runtimeRefresh: ownership.runtimeRefresh,
          };
          notifyCommitted();
          return;
        }
        // Runtime owners publish env at their commit edge. Keep this idempotent
        // fallback for effective-config-unchanged transactions without a
        // dedicated runtime publication callback.
        ownership.publishRuntimeEnv();
        currentRuntimeEnvSourceConfig = nextSourceConfig;
        if (persistedHash === lastSourceOnly?.hash) {
          lastSourceOnly = undefined;
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
        await publishedSource?.rollback();
        throw error;
      }
      notifyCommitted();
    };
    if (changedPaths.length === 0 && !pluginLifecycle) {
      await commitReloadBaseline();
      publishedSource?.commit?.();
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
      previousConfig: currentConfig,
      previousCompareConfig: currentCompareConfig,
      candidateCompareConfig: nextCompareConfig,
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
    if (application?.requireImmediateApplication && (plan.restartGateway || plan.reloadPlugins)) {
      throw new Error(
        "The plugin or restart requirement changed before activation. Complete that update separately, then retry the saved sign-in.",
      );
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
    await runOutsideSetupCredentialAccess(() => (runTransaction ? runTransaction(run) : run()));
  };

  const acceptCurrentRuntimeEcho = async (
    transactionEpoch: number,
    snapshot: ConfigFileSnapshot,
    runtimeApplied: boolean,
    assertLeaseOwned: () => void,
  ) => {
    const sourceOnly = runtimeApplied ? undefined : lastSourceOnly;
    const runtimeRefresh = runtimeApplied ? currentRuntimeRefresh : sourceOnly?.runtimeRefresh;
    const checkpointOwned = async (assertOwned: () => void) => {
      if (stopped || source.observation.revision !== transactionEpoch) {
        throw new GatewayConfigReloadSupersededError();
      }
      assertOwned();
    };
    const ownership: GatewayConfigReloadTransactionOwnership = {
      isCurrent: () => !stopped && source.observation.revision === transactionEpoch,
      checkpoint: () => checkpointOwned(assertLeaseOwned),
      withRestartPreparation: (run) => withRestartPreparation(ownership, checkpointOwned, run),
      reapplyRuntimeOverlays: sourceOnly?.reapplyRuntimeOverlays ?? currentReapplyRuntimeOverlays,
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
        sourceOnly?.config ?? currentConfig,
        ownership,
        sourceOnly?.sourceConfig ?? currentSourceConfig,
        { runtimeApplied },
      );
      assertLeaseOwned();
      if (!ownership.isCurrent()) {
        throw new GatewayConfigReloadSupersededError();
      }
      if (snapshot.valid && typeof snapshot.hash === "string") {
        await updateAcceptedSnapshot(hashConfigRaw(snapshot.raw), snapshot.parsed);
      }
    });
    source.accept(transactionEpoch);
    if (snapshot.valid) {
      await source.acceptPaths(snapshot.includedPaths ?? []);
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
    if (retryWriteCandidate === candidate) {
      retryWriteCandidate = null;
    }
    await source.acceptPaths(snapshot.includedPaths ?? []);
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
            const snapshot = pendingWrite.snapshot;
            assertLeaseOwned();
            if (
              !snapshot.exists ||
              !snapshot.valid ||
              source.observation.writerRevision > pendingWrite.epoch ||
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
          if (isConfigReloadSuperseded(err) && source.observation.revision > pendingWrite.epoch) {
            pending = true;
          }
          if (
            source.observation.writerRevision <= pendingWrite.epoch &&
            !pendingInProcessConfig &&
            !retryWriteCandidate
          ) {
            retryWriteCandidate = pendingWrite;
          }
          throw err;
        } finally {
          if (activeInProcessConfig === pendingWrite) {
            activeInProcessConfig = null;
          }
        }
        return;
      }
      const transactionEpoch = source.observation.revision;
      const intentCandidate = retryWriteCandidate;
      attemptedCandidate = intentCandidate;
      const snapshot = await source.readSnapshot();
      assertLeaseOwned();
      if (source.observation.revision !== transactionEpoch) {
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
      await source.observePaths(snapshot.includedPaths ?? []);
      assertLeaseOwned();
      const observedRawHash = hashConfigRaw(snapshot.raw);
      const previousObservedRawHash = lastObservedRawHash;
      const newObservedRawHash = observedRawHash !== previousObservedRawHash;
      lastObservedRawHash = observedRawHash;
      if (
        intentCandidate &&
        snapshot.valid &&
        configSourceSnapshotsMatch(snapshot, intentCandidate.snapshot)
      ) {
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
          if (source.observation.revision === transactionEpoch && !retryWriteCandidate) {
            retryWriteCandidate = intentCandidate;
          }
          throw err;
        }
        return;
      }
      if (retryWriteCandidate === intentCandidate) {
        settleApplication(intentCandidate, "superseded");
        retryWriteCandidate = null;
      }
      if (acceptedSourceSnapshot && configSourceSnapshotsMatch(snapshot, acceptedSourceSnapshot)) {
        await acceptCurrentRuntimeEcho(
          transactionEpoch,
          snapshot,
          snapshot.hash !== lastSourceOnly?.hash,
          assertLeaseOwned,
        );
        return;
      }
      acceptedSourceSnapshot = undefined;
      if (!snapshot.valid) {
        if (newObservedRawHash) {
          await appendExternalAudit({
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
      const writerSlot = await readLatestConfigSnapshotAuditRecordAsync(
        undefined,
        assertSourceLive,
      );
      const matchingWriterSlot = configSnapshotAuditRecordMatchesPath(writerSlot, opts.watchPath)
        ? writerSlot
        : null;
      if (
        newObservedRawHash &&
        (nextRawHash === currentRawHash || matchingWriterSlot?.rawHash !== nextRawHash)
      ) {
        // Returning to accepted bytes after a rejected edit is still an observed transition.
        // A slot upsert can race awaitWriteFinish; the rare duplicate still carries exact hashes.
        await appendExternalAudit({
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
      await source.acceptPaths(snapshot.includedPaths ?? []);
    } catch (err) {
      const superseded = isConfigReloadSuperseded(err);
      if (!superseded || retryWriteCandidate !== attemptedCandidate) {
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

  function trackReload(reload: Promise<unknown>): void {
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
        const reload = watcherReload;
        if (!running || !reload) {
          break;
        }
        await reload;
      }
      params.assertInvokerOwned?.();
      if (stopped) {
        throw new Error("Gateway plugin lifecycle is stopped.");
      }
      running = true;
      // The operation may consume a real observation, but failure must not discard its timer.
      pending ||= debounceTimer !== null;
      clearReloadTimer();
      let candidate = pendingInProcessConfig ?? retryWriteCandidate;
      let committed = false;
      try {
        const expectedSourceConfig = params.write
          ? params.write.persistedSourceConfig
          : params.config;
        // Refresh identity and bytes without inventing independent passive reload work.
        source.observe(undefined, false);
        const epoch = source.observation.revision;
        const snapshot = await source.readSnapshot();
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
        if (source.observation.writerRevision > epoch) {
          throw new GatewayConfigReloadSupersededError();
        }
        const matchesSnapshot = (queued: typeof candidate) =>
          queued !== null && configSourceSnapshotsMatch(snapshot, queued.snapshot);
        if (!matchesSnapshot(candidate)) {
          if (candidate !== retryWriteCandidate) {
            settleApplication(candidate, "superseded");
          }
          candidate = matchesSnapshot(retryWriteCandidate) ? retryWriteCandidate : null;
        }
        if (retryWriteCandidate && retryWriteCandidate !== candidate) {
          settleApplication(retryWriteCandidate, "superseded");
          retryWriteCandidate = null;
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
        if (retryWriteCandidate === candidate) {
          retryWriteCandidate = null;
        }
        await source.acceptPaths(snapshot.includedPaths ?? []);
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
    trackReload(operation);
    return operation;
  };

  const source = createConfigSource({
    path: opts.watchPath,
    includedPaths: opts.initialIncludedPaths,
    readSnapshot: () => opts.readSnapshot(currentRuntimeEnvSourceConfig),
    subscribeToWrites: opts.subscribeToWrites,
    log: opts.log,
    onReady: (isCurrent) => {
      opts.onWatcherReady?.();
      trackReload(reconcileInitialSource(isCurrent));
    },
    onObserved: (observation) => {
      opts.onConfigCandidateObserved?.();
      const event = observation.write;
      if (!event) {
        if (pendingInProcessConfig || activeInProcessConfig) {
          scheduleAfter(0);
        } else {
          schedule();
        }
        return;
      }
      const application = getRuntimeConfigWriteApplication(event)?.claim();
      // Unapplied restart intent survives coalescing and transient missing-file observations.
      const pendingRestartIntent = [
        pendingInProcessConfig,
        activeInProcessConfig,
        retryWriteCandidate,
      ].find((candidate) => candidate?.afterWrite?.mode === "restart")?.afterWrite;
      settleApplication(pendingInProcessConfig, "superseded");
      settleApplication(retryWriteCandidate, "superseded");
      retryWriteCandidate = null;
      const afterWrite =
        pendingRestartIntent && event.afterWrite?.mode !== "restart"
          ? pendingRestartIntent
          : event.afterWrite;
      pendingInProcessConfig = {
        config: event.runtimeConfig,
        compareConfig: event.sourceConfig,
        persistedHash: event.persistedHash,
        snapshot: event.snapshot,
        afterWrite,
        ...(event.preparedCandidate ? { preparedCandidate: event.preparedCandidate } : {}),
        ...(event.runtimeRefresh ? { runtimeRefresh: event.runtimeRefresh } : {}),
        ...(application ? { application } : {}),
        epoch: observation.revision,
      };
      scheduleAfter(0);
    },
  });

  const reconcileInitialSource = async (isCurrent: () => boolean) => {
    const observed = source.observation;
    try {
      const snapshot = await source.readSnapshot(observed);
      if (!isCurrent() || source.observation !== observed) {
        return;
      }
      const includedPaths = snapshot.includedPaths ?? [];
      const initialPaths = opts.initialIncludedPaths ?? [];
      const sameRoot = snapshot.exists
        ? hashConfigRaw(snapshot.raw) === currentRawHash
        : currentRawHash === null;
      if (
        snapshot.valid &&
        sameRoot &&
        initialPaths.length === includedPaths.length &&
        initialPaths.every((path) => includedPaths.includes(path)) &&
        (includedPaths.length === 0 ||
          diffConfigPaths(currentSourceConfig, snapshot.sourceConfig).length === 0)
      ) {
        return;
      }
    } catch (error) {
      if (!isCurrent() || source.observation !== observed) {
        return;
      }
      opts.log.warn(`config reload initial watch check failed: ${String(error)}`);
    }
    source.observe();
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
    currentSnapshotSlot = await readLatestConfigSnapshotAuditRecordAsync(
      undefined,
      assertSourceLive,
    );
    // A write captured during validation owns the newer audit baseline.
    if (source.observation.revision === 0) {
      const priorSnapshot = configSnapshotAuditRecordMatchesPath(
        currentSnapshotSlot,
        opts.watchPath,
      )
        ? currentSnapshotSlot
        : null;
      if (priorSnapshot && opts.initialSnapshotRawHash === null) {
        currentRawHash = priorSnapshot.rawHash;
        currentFingerprintedAuthoredConfig = priorSnapshot.fingerprintedAuthoredConfig;
        await appendExternalAudit({
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
        await appendExternalAudit({
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
        await updateAcceptedSnapshot(opts.initialSnapshotRawHash, opts.initialAuthoredConfig);
      }
    }
    currentPluginInstallRecords = initialPluginInstallRecords;
    // Async preparation can outlive disk changes before the initial watch scan.
    source.start();
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
      settleApplication(retryWriteCandidate, "stopped");
      clearReloadTimer();
      await source.stop();
      await ready.catch(() => {});
      // Timer callbacks detach runReload; shutdown owns their full transaction unwind.
      await Promise.all(activeReloads);
    },
    hotReloadStatus: () => (initialized ? source.status() : undefined),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
