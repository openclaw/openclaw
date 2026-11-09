import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { copyConfigResolutionFacts } from "../config/resolution-facts.js";
import { publishSystemEventStoreConfig } from "../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyLoggingConfig } from "../logging/logger.js";
import {
  runOutsideGatewayRootWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeSnapshotRevisionState } from "../secrets/runtime-state.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import { resetSkillSnapshotConfigFingerprintCache } from "../skills/runtime/snapshot-config-fingerprint.js";
import { invalidateConfigGetResponseCache } from "./config-get-response.js";
import {
  startGatewayConfigReloader,
  type GatewayConfigReloadTransactionOwnership,
  type GatewayReloadPlan,
} from "./config-reload.js";
import { publishOperatorRoleConfigChange } from "./operator-role-policy.js";
import {
  assertReloadPublicationCurrent,
  GatewayConfigReloadSupersededError,
  GatewayHotReloadRecoveryError,
  GatewayHotReloadStaleSecretsError,
  type CurrentRuntimeSecretsPreparation,
  type GatewayRestartTransactionResult,
  type ManagedGatewayConfigReloaderHandle,
  type ManagedGatewayConfigReloaderParams,
  type RuntimeSecretsPreflightParams,
} from "./server-reload-contracts.js";
import { abortPendingChannelReloads } from "./server-reload-generation.js";
import { createGatewayReloadHandlers } from "./server-reload-hot.js";
import {
  createManagedReloadSecretHandlers,
  isRuntimeSecretsPreparationCurrent,
} from "./server-reload-managed-secrets.js";
import {
  assertIrreversibleReloadPlanHasRecoveryOwner,
  restoreCanonicalSecretRefs,
} from "./server-reload-utils.js";
import {
  disconnectStaleSharedGatewayAuthClients,
  type SharedGatewaySessionGenerationOwnership,
} from "./server-shared-auth-generation.js";

export function startManagedGatewayConfigReloader(
  params: ManagedGatewayConfigReloaderParams,
): ManagedGatewayConfigReloaderHandle {
  // Keep this Gateway's owners across deferred writes. A module snapshot would
  // retain the first Gateway's closed SDK host after an in-process restart.
  const runInGatewayReloadContext = AsyncLocalStorage.snapshot();
  const lifecycle = new AbortController();
  if (params.minimalTestGateway) {
    return {
      ready: Promise.resolve(),
      getCommittedRuntimeConfig: () => params.initialConfig,
      stop: async () => {
        lifecycle.abort(new GatewayConfigReloadSupersededError());
      },
      applyPluginLifecycleChange: async () => {
        throw new Error("Plugin lifecycle is unavailable in a minimal Gateway.");
      },
      isConfigReloadSettled: () => !lifecycle.signal.aborted,
    };
  }

  const applyRuntimeConfigOverrides = (config: OpenClawConfig): OpenClawConfig => {
    const applied = params.applyRuntimeConfigOverrides?.(config) ?? config;
    copyConfigResolutionFacts(config, applied);
    return applied;
  };
  const prepareRuntimeCandidate = (
    runtimeConfig: OpenClawConfig,
    sourceConfig: OpenClawConfig,
    ownership?: GatewayConfigReloadTransactionOwnership,
  ): OpenClawConfig => {
    const canonicalConfig = restoreCanonicalSecretRefs(runtimeConfig, sourceConfig);
    copyConfigResolutionFacts(sourceConfig, canonicalConfig);
    const candidateConfig = ownership?.reapplyRuntimeOverlays(canonicalConfig) ?? canonicalConfig;
    return applyRuntimeConfigOverrides(candidateConfig);
  };
  const restartRecoveryAvailable =
    params.restartRecoveryAvailable !== false && params.requestRecoveryRestart !== undefined;

  const tryPrepareRuntimeSecrets = async (
    config: OpenClawConfig,
    transactionOwnership: GatewayConfigReloadTransactionOwnership,
    activationParams: RuntimeSecretsPreflightParams,
  ): Promise<CurrentRuntimeSecretsPreparation | null> => {
    await transactionOwnership.checkpoint();
    assertReloadPublicationCurrent(transactionOwnership.isCurrent(), false);
    const expectedRevision = getActiveSecretsRuntimeSnapshotRevisionState();
    try {
      const snapshot = await params.activateRuntimeSecrets(config, {
        ...activationParams,
        activate: false,
        canPublishFailureAsDegraded: () =>
          transactionOwnership.isCurrent() &&
          getActiveSecretsRuntimeSnapshotRevisionState() === expectedRevision,
      });
      await transactionOwnership.checkpoint();
      assertReloadPublicationCurrent(transactionOwnership.isCurrent(), false);
      return getActiveSecretsRuntimeSnapshotRevisionState() === expectedRevision
        ? { snapshot, expectedRevision }
        : null;
    } catch (error) {
      // Shutdown still joins admitted work; keep its failure instead of replacing it with cancellation.
      if (lifecycle.signal.aborted) {
        throw error;
      }
      await transactionOwnership.checkpoint();
      assertReloadPublicationCurrent(transactionOwnership.isCurrent(), false);
      if (getActiveSecretsRuntimeSnapshotRevisionState() !== expectedRevision) {
        return null;
      }
      throw error;
    }
  };
  let activeGmailRestartAbortController: AbortController | null = null;
  const abortActiveGmailRestart = () => {
    activeGmailRestartAbortController?.abort();
    activeGmailRestartAbortController = null;
  };
  const createGmailRestartAbortController = (): AbortController => {
    abortActiveGmailRestart();
    const abortController = new AbortController();
    if (lifecycle.signal.aborted) {
      abortController.abort();
      return abortController;
    }
    activeGmailRestartAbortController = abortController;
    return abortController;
  };
  // Keep accepted restart requirements visible until a replacement Gateway starts.
  let acceptedRestart: { plan: GatewayReloadPlan; sourceConfig: OpenClawConfig } | undefined;
  const {
    applyHotReload,
    hasPendingModelRuntimeReload,
    getDeferredChannelReloads,
    acceptRestartConfig,
    beginGatewayRestartLifecycle,
    hasOutstandingGatewayRestart,
    pauseGatewayRestartForConfigCandidate,
    publishAppliedConfigHash,
    publishDeferredAppliedConfigHash,
    requestGatewayRestart,
    stopRestartRetries,
  } = createGatewayReloadHandlers({
    ...params,
    hasAcceptedRestart: () => acceptedRestart !== undefined,
    onRecoveryRestartRequired: (plan, sourceConfig) => {
      acceptedRestart = { plan, sourceConfig };
    },
    releaseChannelRouteHandoffs: params.channelManager.releaseChannelRouteHandoffs,
    pruneInactiveChannelAccountState: params.channelManager.pruneInactiveChannelAccountState,
    createGmailRestartAbortController,
    clearGmailRestartAbortController: (abortController) => {
      if (activeGmailRestartAbortController === abortController) {
        activeGmailRestartAbortController = null;
      }
    },
    assertRestartReady: (config) =>
      import("../state/openclaw-database-preflight.js").then(({ assertOpenClawDatabasesReady }) =>
        assertOpenClawDatabasesReady({ env: process.env, operation: "gateway-restart", config }),
      ),
    restartRecoveryAvailable,
  });
  const runManagedRestart = async (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    transactionOwnership: GatewayConfigReloadTransactionOwnership,
    sourceConfig: OpenClawConfig,
    beforeRestartRequest?: () => Promise<void>,
  ) => {
    const isCurrent = () => !lifecycle.signal.aborted && transactionOwnership.isCurrent();
    const assertCurrent = () => {
      if (!isCurrent()) {
        throw new GatewayConfigReloadSupersededError();
      }
    };
    await transactionOwnership.checkpoint();
    assertCurrent();
    const restartLifecycle = beginGatewayRestartLifecycle();
    let preparation:
      | {
          ownership: SharedGatewaySessionGenerationOwnership;
          previousRequired: string | undefined | null;
          previousCurrent: string | undefined;
          nextGeneration: string | undefined;
          previousRuntimeConfig: OpenClawConfig;
          runtimeConfig: OpenClawConfig;
        }
      | undefined;
    try {
      for (;;) {
        await transactionOwnership.checkpoint();
        assertCurrent();
        const ownership = params.sharedGatewaySessionGenerationState.capture();
        const previousRuntimeConfig = committedRuntimeConfig;
        const previousRequired = params.sharedGatewaySessionGenerationState.required;
        const prepared = await tryPrepareRuntimeSecrets(
          prepareRuntimeCandidate(nextConfig, sourceConfig, transactionOwnership),
          transactionOwnership,
          {
            reason: "restart-check",
            publishFailureAsDegraded: true,
            ...(transactionOwnership.runtimeEnv
              ? { env: transactionOwnership.runtimeEnv.env }
              : {}),
          },
        );
        await transactionOwnership.checkpoint();
        assertCurrent();
        const generationChanged = !params.sharedGatewaySessionGenerationState.owns(ownership);
        if (!prepared || !isRuntimeSecretsPreparationCurrent(prepared) || generationChanged) {
          continue;
        }
        preparation = {
          ownership,
          previousRequired,
          previousCurrent: ownership.generation,
          previousRuntimeConfig,
          nextGeneration: params.resolveSharedGatewaySessionGenerationForConfig(
            prepared.snapshot.config,
          ),
          runtimeConfig: prepared.snapshot.config,
        };
        break;
      }
    } catch (error) {
      restartLifecycle.settle("rejected");
      throw error;
    }
    const {
      ownership: preparationOwnership,
      previousRequired: previousRequiredSharedGatewaySessionGeneration,
      previousCurrent: previousSharedGatewaySessionGeneration,
      nextGeneration: nextSharedGatewaySessionGeneration,
      runtimeConfig: preparedRuntimeConfig,
      previousRuntimeConfig,
    } = preparation;
    let restartTransaction: GatewayRestartTransactionResult | undefined;
    let requiredOwnership: SharedGatewaySessionGenerationOwnership | null = null;
    try {
      await transactionOwnership.checkpoint();
      assertCurrent();
      await params.reconcileRuntimePolicy(preparedRuntimeConfig, "restart");
      await transactionOwnership.checkpoint();
      assertCurrent();
      await beforeRestartRequest?.();
      await transactionOwnership.checkpoint();
      assertCurrent();
      // Claim the shared-session requirement before creating any async restart
      // emission. A rejected generation owner must never leave a live deferral.
      requiredOwnership = params.sharedGatewaySessionGenerationState.setRequired(
        preparationOwnership,
        previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration
          ? nextSharedGatewaySessionGeneration
          : null,
      );
      if (!requiredOwnership) {
        throw new GatewayHotReloadStaleSecretsError();
      }
      // Restart successors inherit process.env. Publish the prepared layer at
      // the admission edge, then roll it back if this restart is rejected.
      transactionOwnership.publishRuntimeEnv();
      restartTransaction = requestGatewayRestart(plan, preparedRuntimeConfig, {
        prepareRuntimeConfig: () =>
          prepareRestartRuntimeConfig(preparedRuntimeConfig, sourceConfig, transactionOwnership),
      });
      if (restartTransaction.status === "recovery-pending") {
        throw new GatewayHotReloadRecoveryError("config restart");
      }
      if (previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration) {
        disconnectStaleSharedGatewayAuthClients({
          state: params.sharedGatewaySessionGenerationState,
          clients: params.clients,
          expectedGeneration: nextSharedGatewaySessionGeneration,
          transition: { previous: previousRuntimeConfig, next: preparedRuntimeConfig },
        });
      }
      restartTransaction.settle("committed");
      transactionOwnership.commitRuntimeEnv();
      restartLifecycle.settle("committed");
      acceptedRestart = { plan, sourceConfig };
    } catch (error) {
      restartTransaction?.settle("rejected");
      restartLifecycle.settle("rejected");
      transactionOwnership.rollbackRuntimeEnv();
      if (requiredOwnership) {
        params.sharedGatewaySessionGenerationState.setRequired(
          requiredOwnership,
          previousRequiredSharedGatewaySessionGeneration,
        );
      }
      throw error;
    }
  };

  const { onEffectiveConfigUnchanged, onHotReload, prepareRestartRuntimeConfig } =
    createManagedReloadSecretHandlers({
      params,
      prepareRuntimeCandidate,
      tryPrepareRuntimeSecrets,
      applyHotReload,
      hasPendingModelRuntimeReload,
    });

  let committedRuntimeConfig = params.initialConfig;
  let configCandidatePending = false;
  const configReloader = startGatewayConfigReloader({
    scheduler: params.scheduler,
    onReloadEnabledChange: params.onReloadEnabledChange,
    initialConfig: params.initialConfig,
    initialCompareConfig: params.initialCompareConfig,
    initialSnapshotRawHash: params.initialSnapshotRawHash,
    initialAuthoredConfig: params.initialAuthoredConfig,
    initialIncludedPaths: params.initialIncludedPaths ?? [],
    initialSnapshotValid: params.initialSnapshotValid,
    initialSnapshotIssues: params.initialSnapshotIssues,
    initialPluginInstallRecords: params.initialPluginInstallRecords,
    // Single notification point for every persisted config change — gateway
    // RPC writes, agent/CLI config_set, doctor, and hand edits all land here
    // once the candidate is accepted. Hash-only; clients refresh via config.get.
    onConfigCandidateCommitted: (info) => {
      invalidateConfigGetResponseCache();
      params.broadcast(
        "config.changed",
        {
          path: info.path,
          hash: info.persistedHash
            ? params.configRevisionProjector.projectRawHash(info.persistedHash)
            : null,
          ts: Date.now(),
        },
        { dropIfSlow: true },
      );
    },
    onRuntimeConfigCommitted: (plan, nextCommittedRuntimeConfig) => {
      const sessionStoresChanged =
        committedRuntimeConfig.session?.store !== nextCommittedRuntimeConfig.session?.store ||
        plan.changedPaths.some((path) => path === "env" || path.startsWith("env."));
      committedRuntimeConfig = nextCommittedRuntimeConfig;
      publishOperatorRoleConfigChange(params.resolveGatewayContext?.());
      // Store retirement follows locator changes, not unrelated presentation commits.
      if (sessionStoresChanged) {
        publishSystemEventStoreConfig(nextCommittedRuntimeConfig);
      }
      void params.resolveGatewayContext?.()?.mentionInbox?.invalidateAsync();
    },
    ...(params.prepareConfigCandidate
      ? { prepareConfigCandidate: params.prepareConfigCandidate }
      : {}),
    runTransaction: (run) =>
      runInGatewayReloadContext(() =>
        runOutsideAsyncWorkScope(() =>
          runOutsideGatewayRootWorkAdmission(() =>
            runWithGatewayIndependentRootWorkAdmission(
              run,
              "reload:config",
              lifecycle.signal,
            ).catch((error: unknown) => {
              // Only the admission wait wraps this stop reason; retain admitted work failures.
              if (
                lifecycle.signal.reason instanceof GatewayConfigReloadSupersededError &&
                error instanceof Error &&
                error.cause === lifecycle.signal.reason
              ) {
                throw lifecycle.signal.reason;
              }
              throw error;
            }),
          ),
        ),
      ),
    readSnapshot: params.readSnapshot,
    promoteSnapshot: async (snapshot, _reason) => await params.promoteSnapshot(snapshot),
    subscribeToWrites: params.subscribeToWrites,
    onConfigCandidateObserved: () => {
      configCandidatePending = true;
      // Every writer must expose persisted revisions before runtime acceptance.
      invalidateConfigGetResponseCache();
      pauseGatewayRestartForConfigCandidate();
    },
    onConfigChange: (plan, nextConfig) => {
      assertIrreversibleReloadPlanHasRecoveryOwner(plan, restartRecoveryAvailable);
      params.prepareTerminalConfig(plan, applyRuntimeConfigOverrides(nextConfig));
    },
    onConfigAccepted: async (nextConfig, transactionOwnership, sourceConfig, acceptance) => {
      const sameRestart =
        acceptedRestart && isDeepStrictEqual(acceptedRestart.sourceConfig, sourceConfig);
      const restart =
        acceptedRestart && (!sameRestart || !acceptance.runtimeApplied)
          ? { retireRejectedRestart: false }
          : acceptRestartConfig();
      if (
        restart.retireRejectedRestart &&
        acceptedRestart &&
        sameRestart &&
        acceptance.runtimeApplied
      ) {
        await runManagedRestart(
          acceptedRestart.plan,
          nextConfig,
          transactionOwnership,
          sourceConfig,
          acceptance.publishSource,
        );
        restart.retireRejectedRestart = false;
      } else {
        await acceptance.publishSource?.();
      }
      await transactionOwnership.checkpoint();
      assertReloadPublicationCurrent(transactionOwnership.isCurrent(), false);
      if (acceptedRestart && !sameRestart && acceptance.runtimeApplied) {
        params.logReload.warn(
          "previously accepted config still requires a Gateway restart; reapply that config or restart the Gateway manually",
        );
      }
      params.acceptTerminalConfig(restart);
      configCandidatePending = false;
      publishDeferredAppliedConfigHash();
    },
    onConfigApplied: (plan, nextConfig) => {
      // Applied runtime identity owns config-derived process memos; accepted
      // source-only changes must not evict caches for the still-active config.
      if (plan.changedPaths.some((path) => path === "logging" || path.startsWith("logging."))) {
        applyLoggingConfig(nextConfig.logging);
      }
      resetSkillSnapshotConfigFingerprintCache();
    },
    onConfigRevisionApplied: publishAppliedConfigHash,
    hasOutstandingGatewayRestart,
    onEffectiveConfigUnchanged,
    onNoopConfigCommit: onHotReload,
    onHotReload,
    onRestart: runManagedRestart,
    log: params.logReload,
    watchPath: params.watchPath,
  });
  return {
    ready: configReloader.ready,
    getCommittedRuntimeConfig: () => committedRuntimeConfig,
    stop: async () => {
      lifecycle.abort(new GatewayConfigReloadSupersededError());
      stopRestartRetries();
      acceptedRestart = undefined;
      // Release managed waiters before the base reloader joins every active transaction.
      abortPendingChannelReloads();
      abortActiveGmailRestart();
      await configReloader.stop();
    },
    hotReloadStatus: configReloader.hotReloadStatus,
    getDeferredChannelReloads,
    applyPluginLifecycleChange: configReloader.applyPluginLifecycleChange,
    // Equal config revisions can still owe a plugin/runtime restart.
    isConfigReloadSettled: () =>
      configReloader.isReady() &&
      !lifecycle.signal.aborted &&
      !configReloader.isReloading() &&
      !configCandidatePending &&
      !hasPendingModelRuntimeReload() &&
      !hasOutstandingGatewayRestart(),
  };
}
