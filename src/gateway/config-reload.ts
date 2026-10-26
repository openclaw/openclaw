import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
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
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { hashRuntimeConfigValue, resolveConfigWriteFollowUp } from "../config/runtime-snapshot.js";
import type { RuntimeConfigSnapshotRefreshOptions } from "../config/runtime-snapshot.js";
import { getRuntimeConfigWriteApplication } from "../config/runtime-write-application.js";
import { createConfigSource, configSourceSnapshotsMatch } from "../config/source.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduledJob } from "../infra/gateway-scheduler.js";
import {
  loadInstalledPluginIndexInstallRecords,
  withPluginInstallRecords,
} from "../plugins/installed-plugin-index-records.js";
import {
  getPluginRuntimeGeneration,
  PluginRuntimeApplicationError,
  type PluginLifecycleRuntimeApply,
  type PluginRuntimeApplication,
} from "../plugins/lifecycle.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import {
  runAfterPluginLifecycleCommit,
  runOutsidePluginLifecycleLease,
  withPluginLifecycleLease,
} from "../plugins/plugin-lifecycle-lease.js";
import {
  captureGatewayRootWorkAdmissionContinuationScope,
  runOutsideGatewayRootWorkAdmission,
  runWithGatewayReloadWaitingRoot,
} from "../process/gateway-work-admission.js";
import { OpenClawStateLeaseAcquisitionError } from "../state/openclaw-state-lease-error.js";
import { createConfigAppliedRevisionTracker } from "./config-applied-revision.js";
import { diffConfigPaths, diffGatewayReloadPaths } from "./config-diff.js";
import {
  candidateApplications,
  createObservedCandidate,
  isConfigReloadSuperseded,
  settleCandidateApplications,
  transferCandidateApplications,
} from "./config-reload-candidates.js";
import { reconcileInitialConfigSource } from "./config-reload-initial-source.js";
import {
  buildGatewayReloadPlan,
  isNoopGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
  resolvePluginInstallReloadMetadata,
  type GatewayReloadPlan,
} from "./config-reload-plan.js";
import { resolveGatewayReloadSettings } from "./config-reload-settings.js";
import { refreshConfigReloadSkills } from "./config-reload-skills.js";
import type {
  GatewayConfigReloader,
  GatewayHotReloadApplication,
} from "./config-reload-status.types.js";
import type {
  GatewayConfigReloadTransactionOwnership,
  GatewayConfigReloaderOptions,
  GatewayConfigReloadCandidate,
  PluginInstallRecords,
} from "./config-reload.types.js";
import { PluginAdmittedWorkTimeoutError } from "./server-plugin-reload-cleanup.js";
import {
  assertConfigReloadWriteSnapshot,
  assertReloadPublicationCurrent,
  GatewayConfigReloadSupersededError,
} from "./server-reload-contracts.js";

export type { GatewayReloadPlan } from "./config-reload-plan.js";
export type { GatewayConfigReloadTransactionOwnership } from "./config-reload.types.js";
const MISSING_CONFIG_RETRY_DELAY_MS = 150;
const MISSING_CONFIG_MAX_RETRIES = 2;
const LEASE_RETRY_INITIAL_DELAY_MS = 250;
const LEASE_RETRY_MAX_DELAY_MS = 5_000;

export function startGatewayConfigReloader(
  opts: GatewayConfigReloaderOptions,
): GatewayConfigReloader {
  // Write listeners schedule jobs inside temporary writer scopes. Reloads belong
  // to this Gateway instance, even after the originating config lock has closed.
  const runInReloadContext = AsyncLocalStorage.snapshot();
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
  let reloadJob: GatewayScheduledJob | null = null;
  let leaseRetryDelayMs = 0;
  let pending = false;
  let running = false;
  let stopped = false;
  let initialized = false;
  let readyCompleted = false;
  let initialReconcile: Promise<void> | undefined;
  let wakeStartup: (() => void) | undefined;
  const wakeStartupDrain = () => {
    wakeStartup?.();
    wakeStartup = undefined;
  };
  const lifecycle = new AbortController();
  const withRestartPreparation = <T>(
    ownership: GatewayConfigReloadTransactionOwnership,
    checkpointOwned: (assertOwned: () => void) => Promise<void>,
    run: (ownership: GatewayConfigReloadTransactionOwnership) => Promise<T>,
  ): Promise<T> =>
    runOutsidePluginLifecycleLease(() =>
      withPluginLifecycleLease({ signal: lifecycle.signal, processBound: true }, async (lease) => {
        // Restart preparation outlives its requesting mutation but still owns a process lease.
        const current = {
          ...ownership,
          assertInvokerOwned: () => lease.assertCurrent(),
          checkpoint: () => checkpointOwned(() => lease.assertCurrent()),
        };
        await current.checkpoint();
        return run(current);
      }),
    );
  let watcherReload: Promise<void> | undefined;
  const activeReloads = new Set<Promise<unknown>>();
  let pluginOperationTail: Promise<unknown> = Promise.resolve();
  let missingConfigRetries = 0;
  let pendingInProcessConfig: GatewayConfigReloadCandidate | null = null;
  let activeConfigCandidate: GatewayConfigReloadCandidate | null = null;
  let retryCandidate: GatewayConfigReloadCandidate | null = null;
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
  let pluginDrainRetry: AbortController | undefined;
  const readPluginInstallRecords = opts.readPluginInstallRecords ?? readCurrentInstallRecords;
  const appliedRevision = createConfigAppliedRevisionTracker({
    onConfigApplied: (plan, nextConfig) =>
      runAfterPluginLifecycleCommit(() => opts.onConfigApplied?.(plan, nextConfig)),
    onRevisionApplied: opts.onConfigRevisionApplied,
  });

  const clearReloadTimer = () => {
    reloadJob?.cancel();
    reloadJob = null;
  };
  const scheduleAfter = (wait: number) => {
    if (stopped || !initialized || opts.scheduler.signal.aborted) {
      return;
    }
    // Coalesce filesystem/write-listener bursts into one reload pass. Config
    // writes often touch temp and final paths in quick succession.
    // Restore instance context at registration so the scheduler can install its
    // own work scope when the callback runs and retain descendant ownership.
    reloadJob = runInReloadContext(() =>
      opts.scheduler.schedule({
        id: "config:reload",
        delayMs: Math.max(wait, leaseRetryDelayMs),
        run: startTrackedReload,
      }),
    );
  };
  const schedule = () => {
    scheduleAfter(pendingInProcessConfig ? 0 : settings.debounceMs);
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
    candidate?: GatewayConfigReloadCandidate | null,
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
      settleCandidateApplications(
        candidate,
        opts.hasOutstandingGatewayRestart?.() ? "applied-restart-required" : status,
      );
    };
    let nextPluginInstallRecords = currentPluginInstallRecords;
    let committedRuntimeConfig: OpenClawConfig | null = null;
    // The reload queue serializes application. New observations belong to the next pass.
    const isCurrent = () => !stopped;
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
      assertOwned();
      assertReloadPublicationCurrent(isCurrent(), false);
    };
    const checkpoint = () => checkpointOwned(assertInvokerOwned);
    const completeApplication = (runtime?: PluginRuntimeApplication) => {
      // Acceptance consumed this observation. A later event keeps its own scheduled work.
      if (isCurrent() && source.observation.revision === initialEpoch) {
        clearReloadTimer();
        pending = false;
        leaseRetryDelayMs = 0;
        source.accept(initialEpoch);
      }
      return { runtime, isCurrent };
    };
    assertInvokerOwned();
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
    // Preparation may use protected credential sources; retain the invoking admission.
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
        // The next queued config is compared against the runtime actually published here.
        commitPublishedRuntimeEnv();
        onRuntimeCommitted?.();
        runAfterPluginLifecycleCommit(() => opts.onRuntimeConfigCommitted?.(plan, runtimeConfig));
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
    const previousPluginInstallConfig = withPluginInstallRecords({}, currentPluginInstallRecords);
    const nextPluginInstallConfig = withPluginInstallRecords({}, nextPluginInstallRecords);
    const pluginInstallRecordChangedPaths = diffConfigPaths(
      previousPluginInstallConfig,
      nextPluginInstallConfig,
    );
    const installMetadata = resolvePluginInstallReloadMetadata(
      previousPluginInstallConfig,
      nextPluginInstallConfig,
    );
    const changedPaths = [...configChangedPaths, ...pluginInstallRecordChangedPaths];
    // Finish the previous publication before preparing the next candidate.
    await appliedRevision.flush(currentConfig);
    await checkpoint();
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
      await appliedRevision.flush(currentConfig);
      await checkpoint();
      // Persisted content changed even when the runtime skipped applying it
      // (writer intent, reload mode off): change listeners still refresh.
      const notifyCommitted = () =>
        runAfterPluginLifecycleCommit(async () => {
          opts.log.info(
            `config source revision ${initialEpoch} accepted (${candidate?.origin ?? "file"})`,
          );
          opts.onReloadEnabledChange?.(nextSettings.mode !== "off");
          if (changedPaths.length > 0) {
            opts.onConfigCandidateCommitted?.({
              path: opts.watchPath,
              persistedHash: persistedHash ?? null,
              changedPaths,
            });
          }
          if (options.runtimeApplied !== false && (changedPaths.length > 0 || pluginLifecycle)) {
            try {
              await refreshConfigReloadSkills(currentConfig);
            } catch (error) {
              opts.log.warn(
                `config applied, but skills discovery refresh failed: ${String(error)}`,
              );
            }
          }
        });
      const acceptConfig = async () => {
        await opts.onConfigAccepted?.(
          committedRuntimeConfig ?? nextConfig,
          ownership,
          nextSourceConfig,
          {
            runtimeApplied: options.runtimeApplied !== false,
            ...(publishSource ? { publishSource } : {}),
          },
        );
      };
      try {
        await acceptConfig();
        await checkpoint();
        if (!publishedSource) {
          await publishSource?.();
        }
        await checkpoint();
        await updateAcceptedSnapshot(hashConfigRaw(sourceSnapshot.raw), sourceSnapshot.parsed);
        await checkpoint();
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
          await notifyCommitted();
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
      await notifyCommitted();
    };
    if (changedPaths.length === 0 && !pluginLifecycle) {
      if (
        candidate &&
        acceptedSourceSnapshot &&
        persistedHash !== lastSourceOnly?.hash &&
        configSourceSnapshotsMatch(sourceSnapshot, acceptedSourceSnapshot) &&
        resolveConfigWriteFollowUp(afterWrite).mode === "auto" &&
        !runtimeRefresh?.includeAuthStoreRefs &&
        !runtimeRefresh?.requireImmediateApplication &&
        !candidateApplications(candidate).some(
          (claim) => claim.prepare || claim.requireImmediateApplication,
        )
      ) {
        // The watcher can publish before the writer's notification arrives. Consume
        // that accepted runtime, not the notification's unresolved SecretRefs.
        await acceptCurrentRuntimeEcho(
          initialEpoch,
          sourceSnapshot,
          true,
          assertInvokerOwned,
          candidate,
        );
        settleRuntimeApplication();
        return completeApplication();
      }
      await commitReloadBaseline();
      pluginDrainRetry?.abort();
      pluginDrainRetry = undefined;
      publishedSource?.commit?.();
      opts.onConfigRevisionApplied?.(nextConfigRevisionHash);
      settleRuntimeApplication();
      return completeApplication();
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
      settleCandidateApplications(candidate, "failed");
      return completeApplication();
    }
    const plan = buildGatewayReloadPlan(changedPaths, {
      pluginLifecycle,
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
    if (nextSettings.mode === "off" && !pluginLifecycle) {
      opts.log.info("config reload disabled (gateway.reload.mode=off)");
      await commitReloadBaseline({ runtimeApplied: false });
      settleCandidateApplications(candidate, "failed");
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
      // Rejection leaves the baseline unchanged so the same config can retry.
      await opts.onRestart(plan, nextConfig, ownership, nextSourceConfig);
      await commitReloadBaseline();
      // The accepted restart owns snapshot republication at next startup.
      settleCandidateApplications(candidate, "restart-pending");
      return completeApplication();
    }

    pluginDrainRetry?.abort();
    pluginDrainRetry = undefined;
    // No-op plans also publish the runtime snapshot before its applied receipt.
    const applyRuntime = isNoopGatewayReloadPlan(plan) ? opts.onNoopConfigCommit : opts.onHotReload;
    await opts.onConfigChange?.(plan, nextConfig);
    let applicationStatus: void | GatewayHotReloadApplication;
    try {
      applicationStatus = await applyRuntime(plan, nextConfig, ownership, nextSourceConfig);
    } catch (error) {
      ownership.rollbackRuntimeEnv();
      if (
        !plan.pluginLifecycle &&
        error instanceof PluginRuntimeApplicationError &&
        error.details.phase === "drain" &&
        !error.details.committed &&
        error.cause instanceof PluginAdmittedWorkTimeoutError
      ) {
        pluginDrainRetry = new AbortController();
        const retrySignal = AbortSignal.any([lifecycle.signal, pluginDrainRetry.signal]);
        void Promise.all(
          error.cause.instances.map((instance) => instance.waitForIdle(retrySignal)),
        ).then(
          () => {
            if (!retrySignal.aborted) {
              schedule();
            }
          },
          () => {
            // Cancellation ends this retry observation, not the serving plugin's work.
          },
        );
      }
      throw error;
    }
    await checkpoint();
    await appliedRevision.apply(plan, nextConfig, nextConfigRevisionHash);
    await commitReloadBaseline();
    settleRuntimeApplication(applicationStatus ?? "applied");
    const runtime =
      typeof applicationStatus === "object" && applicationStatus.status === "applied"
        ? applicationStatus.runtime
        : undefined;
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

  const runWithCandidateWaitingRoots = <T>(
    run: () => Promise<T>,
    candidate?: GatewayConfigReloadCandidate | null,
  ): Promise<T> => {
    const invoke =
      captureGatewayRootWorkAdmissionContinuationScope()?.run ?? runOutsideGatewayRootWorkAdmission;
    let transaction = () => invoke(run);
    for (const application of candidateApplications(candidate)) {
      const continuation = application.runTransaction;
      if (continuation) {
        const next = transaction;
        transaction = () => continuation(() => runWithGatewayReloadWaitingRoot(next));
      }
    }
    return transaction();
  };

  const runAcceptedTransaction = async (
    run: () => Promise<void>,
    candidate?: GatewayConfigReloadCandidate,
  ) => {
    const runTransaction = candidate?.application?.runTransaction ?? opts.runTransaction;
    const transaction = () => runWithCandidateWaitingRoots(run, candidate);
    await runOutsideSetupCredentialAccess(() =>
      runTransaction ? runTransaction(transaction) : transaction(),
    );
  };

  const acceptCurrentRuntimeEcho = async (
    transactionEpoch: number,
    snapshot: ConfigFileSnapshot,
    runtimeApplied: boolean,
    assertLeaseOwned: () => void,
    candidate?: GatewayConfigReloadCandidate,
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
    }, candidate);
    source.accept(transactionEpoch);
    if (snapshot.valid) {
      await source.acceptPaths(snapshot.includedPaths ?? []);
    }
  };

  const applyCandidateSnapshot = async (
    snapshot: ConfigFileSnapshot,
    candidate: GatewayConfigReloadCandidate,
    epoch: number,
    assertLeaseOwned: () => void,
  ) => {
    const applied = await applySnapshot(snapshot, candidate, epoch, {
      assertInvokerOwned: assertLeaseOwned,
    });
    if (activeConfigCandidate === candidate) {
      activeConfigCandidate = null;
    }
    await source.acceptPaths(snapshot.includedPaths ?? []);
    if (applied.isCurrent()) {
      await promoteAcceptedSnapshot(
        snapshot,
        candidate.origin === "write" ? "in-process-write" : "valid-config",
      );
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
    let attemptedCandidate: GatewayConfigReloadCandidate | null = null;
    try {
      if (pendingInProcessConfig) {
        const pendingWrite = pendingInProcessConfig;
        attemptedCandidate = pendingWrite;
        pendingInProcessConfig = null;
        activeConfigCandidate = pendingWrite;
        missingConfigRetries = 0;
        try {
          await runAcceptedTransaction(async () => {
            const snapshot = pendingWrite.snapshot;
            assertConfigReloadWriteSnapshot(snapshot);
            if (
              source.observation.writerRevision > pendingWrite.epoch ||
              activeConfigCandidate !== pendingWrite ||
              snapshot.hash !== pendingWrite.persistedHash ||
              diffConfigPaths(snapshot.sourceConfig, pendingWrite.compareConfig).length > 0
            ) {
              throw new GatewayConfigReloadSupersededError();
            }
            await applyCandidateSnapshot(
              snapshot,
              pendingWrite,
              pendingWrite.epoch,
              assertLeaseOwned,
            );
          }, pendingWrite);
        } catch (err) {
          if (isConfigReloadSuperseded(err) && source.observation.revision > pendingWrite.epoch) {
            pending = true;
          }
          if (
            source.observation.writerRevision <= pendingWrite.epoch &&
            !pendingInProcessConfig &&
            !retryCandidate
          ) {
            retryCandidate = pendingWrite;
          }
          throw err;
        } finally {
          if (activeConfigCandidate === pendingWrite) {
            activeConfigCandidate = null;
          }
        }
        return;
      }
      const transactionEpoch = source.observation.revision;
      const intentCandidate = retryCandidate;
      attemptedCandidate = intentCandidate;
      const snapshot = await source.readSnapshot();
      if (source.observation.revision !== transactionEpoch) {
        throw new GatewayConfigReloadSupersededError();
      }
      const missingRetriesExhausted =
        !snapshot.exists && missingConfigRetries >= MISSING_CONFIG_MAX_RETRIES;
      if (handleMissingSnapshot(snapshot)) {
        if (missingRetriesExhausted) {
          settleCandidateApplications(intentCandidate, "failed");
        }
        await appliedRevision.flush(currentConfig);
        return;
      }
      await source.observePaths(snapshot.includedPaths ?? []);
      const observedRawHash = hashConfigRaw(snapshot.raw);
      const previousObservedRawHash = lastObservedRawHash;
      const newObservedRawHash = observedRawHash !== previousObservedRawHash;
      lastObservedRawHash = observedRawHash;
      if (
        intentCandidate &&
        snapshot.valid &&
        configSourceSnapshotsMatch(snapshot, intentCandidate.snapshot)
      ) {
        retryCandidate = null;
        activeConfigCandidate = intentCandidate;
        try {
          await runAcceptedTransaction(async () => {
            await applyCandidateSnapshot(
              snapshot,
              intentCandidate,
              transactionEpoch,
              assertLeaseOwned,
            );
          }, intentCandidate);
        } catch (err) {
          if (!pendingInProcessConfig && !retryCandidate) {
            retryCandidate = intentCandidate;
          }
          throw err;
        }
        return;
      }
      let observedCandidate: GatewayConfigReloadCandidate | null = null;
      if (retryCandidate === intentCandidate) {
        observedCandidate = createObservedCandidate(snapshot, transactionEpoch, [intentCandidate]);
        retryCandidate = null;
      }
      attemptedCandidate = observedCandidate;
      activeConfigCandidate = observedCandidate;
      if (
        !observedCandidate &&
        acceptedSourceSnapshot &&
        configSourceSnapshotsMatch(snapshot, acceptedSourceSnapshot)
      ) {
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
        (observedRawHash === currentRawHash || matchingWriterSlot?.rawHash !== observedRawHash)
      ) {
        // Returning to accepted bytes after a rejected edit is still an observed transition.
        // A slot upsert can race awaitWriteFinish; the rare duplicate still carries exact hashes.
        await appendExternalAudit({
          detectedBy: "watch",
          previousHash: previousObservedRawHash,
          nextHash: observedRawHash,
          valid: true,
          ...(journalChangedPaths.length > 0
            ? { changedPaths: capConfigAuditPaths(journalChangedPaths) }
            : {}),
          // No config-path diff means the raw edit was comments or formatting only.
          ...(journalChangedPaths.length === 0 ? { opaqueChange: true } : {}),
        });
      }
      await runAcceptedTransaction(async () => {
        if (observedCandidate) {
          await applyCandidateSnapshot(
            snapshot,
            observedCandidate,
            transactionEpoch,
            assertLeaseOwned,
          );
          return;
        }
        const applied = await applySnapshot(snapshot, undefined, transactionEpoch, {
          assertInvokerOwned: assertLeaseOwned,
        });
        if (applied.isCurrent()) {
          await promoteAcceptedSnapshot(snapshot, "valid-config");
        }
      }, observedCandidate ?? undefined);
      await source.acceptPaths(snapshot.includedPaths ?? []);
    } catch (err) {
      const superseded = isConfigReloadSuperseded(err);
      if (superseded && pendingInProcessConfig) {
        pendingInProcessConfig.carriedApplications = [
          ...(pendingInProcessConfig.carriedApplications ?? []),
          ...transferCandidateApplications(
            attemptedCandidate,
            pendingInProcessConfig.compareConfig,
          ),
        ];
      }
      if (
        superseded &&
        attemptedCandidate &&
        !pendingInProcessConfig &&
        !retryCandidate &&
        source.observation.writerRevision <= attemptedCandidate.epoch
      ) {
        retryCandidate = attemptedCandidate;
        pending = true;
      }
      if (!superseded || retryCandidate !== attemptedCandidate) {
        settleCandidateApplications(attemptedCandidate, superseded ? "superseded" : "failed");
      }
      if (superseded) {
        opts.log.info(`config reload superseded: ${String(err)}`);
      } else {
        opts.log.error(`config reload failed: ${String(err)}`);
      }
    } finally {
      if (activeConfigCandidate === attemptedCandidate) {
        activeConfigCandidate = null;
      }
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

  function startTrackedReload(): void | Promise<void> {
    if (stopped || !initialized) {
      return;
    }
    if (running || watcherReload) {
      pending = true;
      return;
    }
    let enteredReload = false;
    // Management enters with the lease held, then takes the config queue. A watcher
    // must use the same order, including when its timer inherited a writer's context.
    // Reload's protected writes stay in this process; package installers own separate leases.
    const reload = runOutsidePluginLifecycleLease(() =>
      withPluginLifecycleLease({ signal: lifecycle.signal, processBound: true }, async (lease) => {
        enteredReload = true;
        leaseRetryDelayMs = 0;
        await runReload(() => lease.assertCurrent());
      }),
    ).catch((error: unknown) => {
      if (stopped) {
        return;
      }
      if (
        !enteredReload &&
        leaseRetryDelayMs < LEASE_RETRY_MAX_DELAY_MS &&
        error instanceof OpenClawStateLeaseAcquisitionError &&
        error.outcome.kind === "store-unavailable" &&
        (error.outcome.reason === "lifecycle-busy" || error.outcome.reason === "sqlite-busy")
      ) {
        pending = true;
        leaseRetryDelayMs = Math.min(
          LEASE_RETRY_MAX_DELAY_MS,
          leaseRetryDelayMs ? leaseRetryDelayMs * 2 : LEASE_RETRY_INITIAL_DELAY_MS,
        );
        opts.log.warn(`config reload retry in ${leaseRetryDelayMs}ms: ${String(error)}`);
      } else {
        if (!enteredReload) {
          // The maximum-backoff attempt exhausts admission. Retain writer intent
          // for a later observation, but release its waiting RPC.
          settleCandidateApplications(pendingInProcessConfig, "failed");
          settleCandidateApplications(retryCandidate, "failed");
          pending = false;
          clearReloadTimer();
        }
        leaseRetryDelayMs = 0;
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
      wakeStartupDrain();
    });
    return reload;
  }

  const applyPluginLifecycleChange: PluginLifecycleRuntimeApply = (params) => {
    const operationId = randomUUID();
    const operation: Promise<PluginRuntimeApplication> = pluginOperationTail.then(async () => {
      params.assertInvokerOwned?.();
      // Callers may hold the lifecycle lease a queued startup reload is waiting for.
      // The startup baseline suffices; `running` below orders this after active reloads.
      await prepared;
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
      pending ||= reloadJob !== null;
      clearReloadTimer();
      const retriedCandidate = retryCandidate;
      let candidate = pendingInProcessConfig ?? retriedCandidate;
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
        activeConfigCandidate = candidate;
        if (source.observation.writerRevision > epoch) {
          throw new GatewayConfigReloadSupersededError();
        }
        const matchesSnapshot = (queued: typeof candidate) =>
          queued !== null && configSourceSnapshotsMatch(snapshot, queued.snapshot);
        const queued = [...new Set([candidate, retryCandidate])];
        const exact = queued.find(matchesSnapshot) ?? null;
        const observed = createObservedCandidate(
          snapshot,
          epoch,
          queued.filter((entry) => entry !== exact),
        );
        candidate = exact ?? observed;
        if (exact && observed) {
          exact.carriedApplications = [
            ...(exact.carriedApplications ?? []),
            ...(observed.carriedApplications ?? []),
          ];
        }
        retryCandidate = null;
        activeConfigCandidate = candidate;
        // Retain the plugin invoker's authority while excluding writers awaiting this application.
        const applied = await runWithCandidateWaitingRoots(
          () =>
            applySnapshot(snapshot, candidate, epoch, {
              pluginLifecycle: {
                pluginIds: params.pluginIds,
                reason: params.reason,
                operationId,
                ...(params.waitForDrain
                  ? { waitForDrain: true, drainSignal: params.drainSignal }
                  : {}),
                expectedSourceDigests: params.expectedSourceDigests,
              },
              onRuntimeCommitted: () => {
                committed = true;
              },
              assertInvokerOwned: params.assertInvokerOwned,
            }),
          candidate,
        );
        if (!applied.runtime) {
          throw new Error("Plugin runtime application did not produce a completed receipt.");
        }
        await source.acceptPaths(snapshot.includedPaths ?? []);
        if (applied.isCurrent()) {
          await promoteAcceptedSnapshot(snapshot, "plugin-lifecycle");
        }
        return applied.runtime;
      } catch (error) {
        if (candidate === retriedCandidate && !pendingInProcessConfig && !retryCandidate) {
          retryCandidate = candidate;
        }
        settleCandidateApplications(candidate, "failed");
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
        if (activeConfigCandidate === candidate) {
          activeConfigCandidate = null;
        }
        running = false;
        if (pending || pendingInProcessConfig) {
          pending = false;
          schedule();
        }
        // This application may have consumed the reload startup is draining.
        wakeStartupDrain();
      }
    });
    // Keep the queue usable; the returned operation and tracked shutdown join retain the failure.
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
      initialReconcile = reconcileInitialConfigSource({
        source,
        isCurrent,
        getAcceptedSource: () => ({ rawHash: currentRawHash, config: currentSourceConfig }),
        initialIncludedPaths: opts.initialIncludedPaths,
        log: opts.log,
      });
      trackReload(initialReconcile);
    },
    onObserved: (observation) => {
      opts.onConfigCandidateObserved?.();
      const event = observation.write;
      if (!event) {
        if (pendingInProcessConfig || activeConfigCandidate) {
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
        activeConfigCandidate,
        retryCandidate,
      ].find((candidate) => candidate?.afterWrite?.mode === "restart")?.afterWrite;
      const carriedApplications = [...new Set([pendingInProcessConfig, retryCandidate])].flatMap(
        (candidate) => transferCandidateApplications(candidate, event.sourceConfig),
      );
      retryCandidate = null;
      const afterWrite =
        pendingRestartIntent && event.afterWrite?.mode !== "restart"
          ? pendingRestartIntent
          : event.afterWrite;
      pendingInProcessConfig = {
        origin: "write",
        config: event.runtimeConfig,
        compareConfig: event.sourceConfig,
        persistedHash: event.persistedHash,
        snapshot: event.snapshot,
        afterWrite,
        ...(event.preparedCandidate ? { preparedCandidate: event.preparedCandidate } : {}),
        ...(event.runtimeRefresh ? { runtimeRefresh: event.runtimeRefresh } : {}),
        ...(application ? { application } : {}),
        carriedApplications,
        epoch: observation.revision,
      };
      scheduleAfter(0);
    },
  });

  // Preparation publishes the startup baseline and joins initial reconciliation;
  // readiness additionally drains the reloads that reconciliation queued.
  const prepared = (async () => {
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
    initialized = true;
    await source.start();
    await initialReconcile;
    if (pendingInProcessConfig || pending) {
      scheduleAfter(0);
    }
  })();
  const ready = (async () => {
    await prepared;
    // A reload can queue another observation while updating watched paths. Join
    // the existing scheduler, outside watcher refresh, until startup settles.
    // A plugin application admitted during startup may consume the queued reload.
    for (;;) {
      await source.whenSettled();
      if (stopped || (!reloadJob && !watcherReload && !running)) {
        break;
      }
      await new Promise<void>((resolve) => {
        wakeStartup = resolve;
      });
    }
    assertSourceLive();
    readyCompleted = true;
  })();

  return {
    ready,
    isReady: () => readyCompleted,
    applyPluginLifecycleChange,
    isReloading: () => activeReloads.size > 0,
    stop: async () => {
      stopped = true;
      wakeStartupDrain();
      lifecycle.abort(new GatewayConfigReloadSupersededError());
      settleCandidateApplications(pendingInProcessConfig, "stopped");
      settleCandidateApplications(activeConfigCandidate, "stopped");
      settleCandidateApplications(retryCandidate, "stopped");
      clearReloadTimer();
      await source.stop();
      // Startup already observes ready's rejection; shutdown only needs its preparation to settle.
      await ready.catch(() => {});
      // Initial reads and explicit plugin operations share the same transaction unwind.
      await Promise.all(activeReloads);
    },
    hotReloadStatus: () => (initialized ? source.status() : undefined),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
