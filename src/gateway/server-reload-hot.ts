import { reloadSessionMcpRuntimes } from "../agents/agent-bundle-mcp-tools.js";
import { listAgentIds } from "../agents/agent-roster.js";
import { tryResolveConfiguredAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { refreshContextWindowCache } from "../agents/context.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import {
  advancePreparedModelRuntimeConfig,
  beginPreparedModelRuntimePluginDrain,
  markPreparedModelRuntimeSnapshotsStale,
  rejectPendingPreparedModelRuntimeReplacement,
  type PreparedModelRuntimeReplacementGateId,
} from "../agents/prepared-model-runtime.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import { isRestartEnabled } from "../config/commands.flags.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import { setGatewayRestartPolicy } from "../infra/restart.js";
import { PluginRuntimeApplicationError, getPluginRuntimeGeneration } from "../plugins/lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { diffConfigPaths } from "./config-diff.js";
import type { ChannelKind, GatewayReloadPlan } from "./config-reload-plan.js";
import {
  doesReloadAffectProviderAuth,
  reloadPlanNeedsRecovery,
  shouldRefreshContextWindowCache,
} from "./config-reload-recovery.js";
import type { GatewayHotReloadApplication } from "./config-reload-status.types.js";
import { commitHookTransformMappingReload } from "./hooks-mapping.js";
import { resolveHooksConfig } from "./hooks.js";
import type { GatewayCronExitWatcherHandoff } from "./server-cron.js";
import { applyGatewayLaneConcurrency, resolveGatewayLaneConcurrency } from "./server-lanes.js";
import { createGatewayActiveWorkTracker } from "./server-reload-active-work.js";
import { reviveAgentDatabasesAfterConfigCommit } from "./server-reload-agent-databases.js";
import { restartGatewayChannels } from "./server-reload-channel-restart.js";
import {
  assertReloadPublicationCurrent,
  createReloadCancellationError,
  GatewayHotReloadRecoveryError,
  type GatewayHotReloadPublication,
  type GatewayPluginReloadResult,
  type GatewayReloadHandlerParams,
  type GatewayRestartTransactionResult,
  type GatewayRuntimePublication,
} from "./server-reload-contracts.js";
import {
  isCurrentGatewayReloadGeneration,
  isGatewayReloadGenerationAborted,
  nextGatewayReloadGeneration,
} from "./server-reload-generation.js";
import * as mrReload from "./server-reload-model-runtime-scope.js";
import { createGatewayRestartCoordinator } from "./server-reload-restart.js";
import {
  assertIrreversibleReloadPlanHasRecoveryOwner,
  disposeMcpRuntimesWithTimeout,
} from "./server-reload-utils.js";
import { startGatewayCronWithLogging } from "./server-runtime-services.js";
import { isChannelStartupSuppressedByEnvironment } from "./server-sidecar-startup-mode.js";
import { resolveHookClientIpConfig } from "./server/hook-client-ip-config.js";

const MCP_RUNTIME_RELOAD_DISPOSE_TIMEOUT_MS = 5_000;

export function createGatewayReloadHandlers(params: GatewayReloadHandlerParams) {
  const myGeneration = nextGatewayReloadGeneration();
  const restartRecoveryAvailable =
    params.restartRecoveryAvailable !== false && params.requestRecoveryRestart !== undefined;

  const {
    formatActiveDetails,
    formatDeferredWorkStatus,
    getActiveCounts,
    getDeferredChannelReloads,
    waitForActiveWorkBeforeChannelReload,
  } = createGatewayActiveWorkTracker({ params, myGeneration });

  const {
    deferGatewayRestartDebt,
    getLatestAcceptedRestartTarget,
    hasRestartRequestTransaction,
    isRestartRetryStopped,
    ...restartCoordinator
  } = createGatewayRestartCoordinator({
    params,
    myGeneration,
    restartRecoveryAvailable,
    getActiveCounts,
    formatActiveDetails,
    formatDeferredWorkStatus,
  });

  const applyHotReload = async (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    publication?: GatewayHotReloadPublication,
  ): Promise<GatewayHotReloadApplication> => {
    publication?.assertInvokerOwned?.();
    assertIrreversibleReloadPlanHasRecoveryOwner(plan, restartRecoveryAvailable);
    const isCurrent = () => !isRestartRetryStopped() && (publication?.isCurrent?.() ?? true);
    const state = params.getState();
    const nextState = { ...state };
    const candidateEnv = publication?.runtimeEnv ?? process.env;
    const committedConfig = getRuntimeConfig();
    const refreshModelRuntime = doesReloadAffectProviderAuth(plan, committedConfig, nextConfig);
    const modelRuntimeAgentIds = mrReload.resolveReloadAgentIds([
      ...plan.changedPaths,
      ...diffConfigPaths(committedConfig, nextConfig),
    ]);
    const modelRuntimeRefreshScope = modelRuntimeAgentIds ? { agentIds: modelRuntimeAgentIds } : {};
    const refreshModelRuntimeSnapshots = (
      config: OpenClawConfig,
      isPublicationCurrent?: () => boolean,
    ) =>
      withPluginRuntimeRegistryScope(params.getPluginRegistry(), () =>
        mrReload.refreshModelRuntimeAfterHotReload({
          config,
          agentIds: modelRuntimeAgentIds,
          pluginMetadataSnapshot: params.getPluginMetadataSnapshot?.(),
          ...(isPublicationCurrent ? { isPublicationCurrent } : {}),
        }),
      );

    if (plan.reloadHooks || plan.refreshHooksPolicy) {
      try {
        nextState.hooksConfig = resolveHooksConfig(nextConfig);
      } catch (err) {
        params.logHooks.warn(`hooks config reload failed: ${String(err)}`);
        throw err;
      }
    }
    nextState.hookClientIpConfig = resolveHookClientIpConfig(nextConfig);
    const internalHooks =
      plan.reloadInternalHooks || plan.reloadPlugins
        ? await (
            await import("../hooks/loader.js")
          ).prepareInternalHooks(
            nextConfig,
            tryResolveConfiguredAgentWorkspaceDir(nextConfig, candidateEnv) ??
              resolveDefaultAgentWorkspaceDir(candidateEnv),
          )
        : undefined;
    await publication?.checkpoint?.();
    assertReloadPublicationCurrent(publication?.isCurrent() ?? true, isRestartRetryStopped());

    // Cron preparation can outlive its reload owner while loading, handing off
    // watchers, or awaiting publication. Recheck before construction and commit.
    const assertCronReloadCurrent = () =>
      assertReloadPublicationCurrent(
        publication?.isCurrent() ?? true,
        isRestartRetryStopped() ||
          !isCurrentGatewayReloadGeneration(myGeneration) ||
          isGatewayReloadGenerationAborted(myGeneration),
      );
    let cronExitWatcherHandoff:
      | { previous: GatewayCronExitWatcherHandoff; next: GatewayCronExitWatcherHandoff }
      | undefined;
    if (plan.restartCron) {
      const { buildGatewayCronService } = await import("./server-cron.js");
      assertCronReloadCurrent();
      nextState.cronState = buildGatewayCronService({
        scheduler: params.scheduler,
        cfg: nextConfig,
        deps: params.deps,
        broadcast: params.broadcast,
        env: publication?.runtimeEnv ?? process.env,
        // Without this a cron hot reload silently drops scheduler gateway
        // context, so scheduled runs regress to contextless after any reload.
        ...(params.resolveGatewayContext
          ? { resolveGatewayContext: params.resolveGatewayContext }
          : {}),
        resolvePluginRegistry: params.getPluginRegistry,
      });
      if (
        state.cronState.cronEnabled &&
        nextState.cronState.cronEnabled &&
        state.cronState.storePath === nextState.cronState.storePath
      ) {
        const [previous, next] = await Promise.all([
          state.cronState.prepareExitWatcherHandoff?.(),
          nextState.cronState.prepareExitWatcherHandoff?.(),
        ]);
        assertCronReloadCurrent();
        if (previous && next) {
          cronExitWatcherHandoff = { previous, next };
        }
      }
    }

    resetDirectoryCache();

    const channelsToRestart = new Set(plan.restartChannels);
    const restartChannelAccounts = new Map<ChannelKind, Set<string>>(
      [...(plan.restartChannelAccounts ?? [])].map(([channel, accountIds]) => [
        channel,
        new Set(accountIds),
      ]),
    );
    let remainingPlan = { ...plan, reloadPlugins: false };
    const prepareConfigEffects: Parameters<
      GatewayReloadHandlerParams["reloadPlugins"]
    >[0]["prepareConfigEffects"] = ({ pluginIds, channels }) => {
      for (const channel of channels) {
        channelsToRestart.delete(channel);
        restartChannelAccounts.delete(channel);
      }
      remainingPlan = {
        ...plan,
        reloadPlugins: false,
        restartChannels: channelsToRestart,
        restartChannelAccounts,
        restartServices: new Set(
          params
            .getPluginRegistry()
            .services.filter(
              (entry) => plan.restartServices?.has(entry.id) && !pluginIds.has(entry.pluginId),
            )
            .map((entry) => entry.id),
        ),
      };
      assertIrreversibleReloadPlanHasRecoveryOwner(remainingPlan, restartRecoveryAvailable);
      const previousConfig = getRuntimeConfig();
      const drain = beginPreparedModelRuntimePluginDrain();
      releasePreparedModelRuntimeDrain = drain.release;
      const retire = () => {
        if (preparedModelRuntimeReplacementGateId) {
          return;
        }
        preparedModelRuntimeReplacementGateId = markPreparedModelRuntimeSnapshotsStale(
          "prepared model runtime owner is stale before plugin replacement",
          { waitForReplacement: true, ...modelRuntimeRefreshScope },
        );
        drain.release();
      };
      // Unfinished publication must cancel its acquisition before the plugin owner drains it.
      if (drain.pendingPublication) {
        retire();
      }
      return {
        retire,
        rollback: async () => {
          if (!preparedModelRuntimeReplacementGateId) {
            return;
          }
          await refreshModelRuntimeSnapshots(
            previousConfig,
            () =>
              isCurrentGatewayReloadGeneration(myGeneration) &&
              !isLifecycleReloadAborted() &&
              !isRestartRetryStopped(),
          );
        },
      };
    };
    let activePluginChannelsAfterReload: ReadonlySet<ChannelKind> | null = null;
    let pluginReloadAborted = false;
    let runtimeCommitted = false;
    let configCommitFailure: { error: unknown } | undefined;
    const failConfigCommit = (error: unknown): never => {
      configCommitFailure = { error };
      throw error;
    };
    const isLifecycleReloadAborted = () => isGatewayReloadGenerationAborted(myGeneration);
    const ownsCron = () =>
      isCurrentGatewayReloadGeneration(myGeneration) &&
      !isLifecycleReloadAborted() &&
      !isRestartRetryStopped() &&
      params.getState().cronState === nextState.cronState;
    const isPluginReloadAborted = () =>
      pluginReloadAborted ||
      (!runtimeCommitted && !isCurrent()) ||
      isRestartRetryStopped() ||
      isLifecycleReloadAborted();
    let preparedModelRuntimeReplacementGateId: PreparedModelRuntimeReplacementGateId | undefined;
    let releasePreparedModelRuntimeDrain: (() => void) | undefined;
    let recoveryRestartScheduled = false;
    const laneConcurrency = resolveGatewayLaneConcurrency(nextConfig);
    // Use one candidate env snapshot before publication and through later channel starts.
    const shouldSkipChannelRestart = isChannelStartupSuppressedByEnvironment(candidateEnv);
    const channelReloadTargets = () =>
      new Set<ChannelKind>([...channelsToRestart, ...restartChannelAccounts.keys()]);
    const getChannelAutostartSuppression = () => params.getChannelAutostartSuppression?.() ?? null;
    const commitRuntime = async (runtime?: GatewayRuntimePublication) => {
      if (runtimeCommitted) {
        return;
      }
      let pluginNotificationFailure: { error: unknown } | undefined;
      const commit = async () => {
        if (plan.restartCron) {
          assertCronReloadCurrent();
        }
        // Plugin publication can reject its prepared registry. Keep config and
        // secret rollback available until that selection succeeds.
        publication?.assertInvokerOwned?.();
        runtime?.publish();
        if (runtime) {
          params.setState(nextState);
          runtimeCommitted = true;
        }
        if (plan.restartHeartbeat) {
          nextState.heartbeatRunner.updateConfig(nextConfig);
        }
        if (refreshModelRuntime) {
          // Retire model/auth inputs together so requests cannot mix generations.
          preparedModelRuntimeReplacementGateId = markPreparedModelRuntimeSnapshotsStale(
            "prepared model runtime owner is stale before config publication",
            { waitForReplacement: true, ...modelRuntimeRefreshScope },
          );
        } else {
          advancePreparedModelRuntimeConfig(nextConfig);
        }
        if (!runtime) {
          params.setState(nextState);
          runtimeCommitted = true;
        }
        // Accepted config owns the remaining effects. A failure here must retain
        // its secrets and report a committed operation instead of restoring old state.
        if (plan.reloadHooks) {
          commitHookTransformMappingReload();
        }
        internalHooks?.commit();
        applyGatewayLaneConcurrency(laneConcurrency);
        try {
          runtime?.afterCommit?.();
        } catch (error) {
          pluginNotificationFailure = { error };
          throw error;
        }
        setGatewayRestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
      };
      try {
        await (publication ? publication.publish(commit, () => runtimeCommitted) : commit());
      } catch (error) {
        if (
          runtimeCommitted &&
          (!pluginNotificationFailure || pluginNotificationFailure.error !== error)
        ) {
          failConfigCommit(error);
        }
        throw error;
      } finally {
        // Commit removes the predecessor from runtime state. Drain it even if
        // later publication fails or the replacement loses lifecycle ownership.
        try {
          if (runtimeCommitted && plan.restartCron) {
            if (ownsCron()) {
              params.cronReconciliation.invalidate();
              params.onCronRestart?.();
            }
            if (cronExitWatcherHandoff && ownsCron()) {
              await cronExitWatcherHandoff.next.adopt(cronExitWatcherHandoff.previous.current());
              await cronExitWatcherHandoff.previous.stopOwner();
            } else if (state.cronState.cron.stopAndDrain) {
              await state.cronState.cron.stopAndDrain();
            } else {
              state.cronState.cron.stop();
              await state.cronState.stopStreamWatchers();
            }
          }
        } catch (error) {
          failConfigCommit(error);
        }
      }
      if (plan.restartHeartbeat) {
        await reviveAgentDatabasesAfterConfigCommit(listAgentIds(nextConfig), (message) =>
          params.logReload.warn(message),
        );
      }
      if (!ownsCron()) {
        return;
      }
      // Only accepted runtime state may own monitor writes and emitted events.
      if (
        plan.reconcileSystemJobs &&
        (await nextState.cronState.reconcileSystemJobs().catch(failConfigCommit)) ===
          "retry-scheduled"
      ) {
        failConfigCommit(new GatewayHotReloadRecoveryError("cron monitor"));
      }
      if (plan.restartCron && ownsCron()) {
        startGatewayCronWithLogging({
          cronState: nextState.cronState,
          cronReconciliation: params.cronReconciliation,
          reason: "reload",
          config: nextConfig,
          afterStart: async () => {
            await Promise.all([
              nextState.cronState.reconcileExitWatchers(),
              nextState.cronState.reconcileStreamWatchers(),
            ]);
          },
          logCron: params.logCron,
          onStartError: (err) => {
            if (!ownsCron()) {
              return;
            }
            try {
              scheduleRecoveryRestart("cron reload", err);
            } catch (recoveryError) {
              params.logCron.error(formatErrorMessage(recoveryError));
            }
          },
        });
      }
    };
    const settleRecoveryRestart = (
      restartTransaction: GatewayRestartTransactionResult,
      surface: string,
    ) => {
      if (restartTransaction.status === "recovery-pending" && !restartRecoveryAvailable) {
        restartTransaction.settle("rejected");
        throw new GatewayHotReloadRecoveryError(surface);
      }
      restartTransaction.settle("committed");
      recoveryRestartScheduled = true;
    };
    const scheduleRecoveryRestart = (surface: string, err?: unknown) => {
      rejectPendingPreparedModelRuntimeReplacement(
        preparedModelRuntimeReplacementGateId,
        err ?? new Error(`prepared model runtime replacement stopped during ${surface}`),
      );
      if (plan.pluginLifecycle && !reloadPlanNeedsRecovery(remainingPlan)) {
        throw new PluginRuntimeApplicationError(
          `Plugin runtime application failed during ${surface}: ${formatErrorMessage(err)}`,
          {
            ...plan.pluginLifecycle,
            pluginIds: [...plan.pluginLifecycle.pluginIds],
            generation: getPluginRuntimeGeneration(),
            phase: runtimeCommitted ? "activate" : "prepare",
            committed: runtimeCommitted,
          },
          { cause: err },
        );
      }
      const detail = err === undefined ? "" : `: ${formatErrorMessage(err)}`;
      if (isRestartRetryStopped()) {
        params.logReload.warn(`${surface} failed during gateway shutdown${detail}`);
        return;
      }
      if (!restartRecoveryAvailable || !params.requestRecoveryRestart) {
        const message = runtimeCommitted
          ? `config hot reload committed with unrecovered ${surface} failure${detail}; gateway restart recovery is unavailable; runtime may be inconsistent`
          : `config hot reload failed before commit during ${surface}${detail}; gateway restart recovery is unavailable`;
        if (params.logReload.error) {
          params.logReload.error(message);
        } else {
          params.logReload.warn(message);
        }
        if (runtimeCommitted) {
          throw new GatewayHotReloadRecoveryError(surface);
        }
        if (err instanceof Error) {
          throw err;
        }
        throw new Error(`config hot reload failed before commit during ${surface}${detail}`);
      }
      const recoveryPlan = {
        ...plan,
        restartGateway: true,
        restartReasons: [`hot reload recovery: ${surface}`],
      };
      if (!isCurrent()) {
        params.logReload.warn(
          `${surface} failed after config supersession${detail}; recovery deferred to the newer config`,
        );
        const target = getLatestAcceptedRestartTarget();
        if (
          !restartCoordinator.hasConfigCandidatePending() &&
          !hasRestartRequestTransaction() &&
          target
        ) {
          const restartTransaction = restartCoordinator.requestGatewayRestart(
            recoveryPlan,
            target.runtimeConfig,
            {
              retainDebtAcrossConfigChanges: true,
              debtConfig: target.sourceConfig,
              prepareRuntimeConfig: target.prepareRuntimeConfig,
            },
          );
          settleRecoveryRestart(restartTransaction, surface);
          return;
        }
        deferGatewayRestartDebt(recoveryPlan, nextConfig, {
          retainDebtAcrossConfigChanges: true,
          debtConfig: publication?.sourceConfig ?? nextConfig,
        });
        return;
      }
      const commitState = runtimeCommitted ? "after config commit" : "before config commit";
      params.logReload.warn(`${surface} failed ${commitState}${detail}; restarting gateway`);
      if (recoveryRestartScheduled) {
        return;
      }
      try {
        // Reuse the config-restart path to drain other work and fence restart delivery.
        const restartTransaction = restartCoordinator.requestGatewayRestart(
          recoveryPlan,
          nextConfig,
          // Recovery debt represents a failed runtime surface, not every path
          // in the hot plan. Keep it until a replacement restart commits.
          {
            retainDebtAcrossConfigChanges: true,
            debtConfig: publication?.sourceConfig ?? nextConfig,
            ...(publication?.prepareRestartRuntimeConfig
              ? { prepareRuntimeConfig: publication.prepareRestartRuntimeConfig }
              : {}),
          },
        );
        settleRecoveryRestart(restartTransaction, surface);
        // Keep the committed transaction accepted while emission recovery retries.
      } catch (restartError) {
        params.logReload.warn(
          `failed to schedule post-commit gateway restart: ${formatErrorMessage(restartError)}`,
        );
        if (restartError instanceof GatewayHotReloadRecoveryError) {
          throw restartError;
        }
        throw new GatewayHotReloadRecoveryError(surface);
      }
    };
    const isReloadOwnerActive = () =>
      isCurrentGatewayReloadGeneration(myGeneration) && !isPluginReloadAborted();
    const reloadRetainedPluginServices = async () => {
      if (!remainingPlan.restartServices?.size || !isReloadOwnerActive()) {
        return;
      }
      // Replaced plugin owners start their own services; this committed config
      // still owns retained services even when a different plugin fails activation.
      try {
        if (!params.reloadPluginServices) {
          throw new Error("Plugin service reload owner is unavailable");
        }
        await params.reloadPluginServices(nextConfig, remainingPlan.restartServices);
      } catch (err) {
        params.logReload.warn(`plugin services reload failed: ${formatErrorMessage(err)}`);
      }
    };
    let pluginRuntimeApplication: GatewayPluginReloadResult["runtime"] | undefined;
    try {
      if (plan.reloadPlugins) {
        // The plugin lifecycle owner drains and restores its own channel/service instances.
        // This config transaction owns only publication and unrelated config effects.
        const result = await params.reloadPlugins({
          nextConfig,
          sourceConfig: publication ? publication.sourceConfig : nextConfig,
          changedPaths: plan.changedPaths,
          reloadPluginIds: plan.reloadPluginIds,
          pluginLifecycle: plan.pluginLifecycle,
          prepareConfigEffects,
          commitRuntime,
          env: publication?.runtimeEnv ?? process.env,
          isAborted: isPluginReloadAborted,
          checkpoint: publication?.checkpoint,
          assertInvokerOwned: publication?.assertInvokerOwned,
        });
        pluginReloadAborted = isPluginReloadAborted();
        if (!pluginReloadAborted) {
          pluginRuntimeApplication = result.runtime;
          activePluginChannelsAfterReload = result.activeChannels;
          params.pruneInactiveChannelAccountState(result.activeChannels);
        }
      }

      const channelTargets = channelReloadTargets();
      // Plugin replacement can admit new agent work while an account monitor stays live.
      // Recheck that work here; durable ingress replay remains owned by the fresh monitor drain.
      if (!pluginReloadAborted && channelTargets.size > 0 && !shouldSkipChannelRestart) {
        const waitCancelled = await waitForActiveWorkBeforeChannelReload(
          channelTargets,
          isCurrent,
          !runtimeCommitted,
        );
        // A committed owner must finish its model/channel tail before the next config runs.
        // Supersession ends this wait: a newer writer may itself be awaiting that next reload.
        pluginReloadAborted = waitCancelled && isPluginReloadAborted();
      }
      if (pluginReloadAborted) {
        // Only an uncommitted reload can transfer its receipt to the watcher. After
        // commit, same-content replay may be a no-op and cannot finish the interrupted tail.
        throw createReloadCancellationError(
          !runtimeCommitted && publication?.isCurrent() === false,
        );
      }
    } catch (error) {
      if (
        runtimeCommitted &&
        (configCommitFailure ||
          (error instanceof PluginRuntimeApplicationError &&
            reloadPlanNeedsRecovery(remainingPlan)))
      ) {
        scheduleRecoveryRestart("runtime commit", configCommitFailure?.error ?? error);
        return "applied-restart-required";
      }
      try {
        if (
          runtimeCommitted &&
          error instanceof PluginRuntimeApplicationError &&
          error.details.committed &&
          isReloadOwnerActive()
        ) {
          // Failed activation leaves the committed registry authoritative. Restore its
          // model/reply owners independently, without clearing the plugin failure.
          try {
            await refreshModelRuntimeSnapshots(nextConfig, isReloadOwnerActive);
          } catch (refreshError) {
            rejectPendingPreparedModelRuntimeReplacement(
              preparedModelRuntimeReplacementGateId,
              refreshError,
            );
            throw new PluginRuntimeApplicationError(
              `Plugin model/reply recovery failed: ${formatErrorMessage(refreshError)}. Retry the plugin reload or restart the Gateway. Original failure: ${formatErrorMessage(error)}`,
              error.details,
              {
                cause: new AggregateError(
                  [error, refreshError],
                  "Plugin model/reply recovery failed",
                ),
              },
            );
          }
        }
      } finally {
        // Service startup can acquire a model owner; settle its gate before joining that startup.
        rejectPendingPreparedModelRuntimeReplacement(preparedModelRuntimeReplacementGateId, error);
        releasePreparedModelRuntimeDrain?.();
        if (runtimeCommitted && error instanceof PluginRuntimeApplicationError) {
          await reloadRetainedPluginServices();
        }
      }
      throw error;
    } finally {
      releasePreparedModelRuntimeDrain?.();
    }
    try {
      await commitRuntime();
    } catch (err) {
      if (!runtimeCommitted) {
        throw err;
      }
      scheduleRecoveryRestart("runtime commit", err);
      return "applied-restart-required";
    }

    try {
      if (refreshModelRuntime) {
        await refreshModelRuntimeSnapshots(nextConfig);
      }
    } catch (err) {
      if (err instanceof PreparedModelRuntimePublicationSupersededError && !isCurrent()) {
        // The newer config owns model publication; cancellation creates no restart debt.
        throw createReloadCancellationError(true);
      }
      scheduleRecoveryRestart("prepared model runtime reload", err);
      return "applied-restart-required";
    } finally {
      await reloadRetainedPluginServices();
    }

    if (plan.disposeMcpRuntimes) {
      await disposeMcpRuntimesWithTimeout({
        dispose: () =>
          reloadSessionMcpRuntimes({
            cfg: nextConfig,
            manifestRegistry: params.getPluginMetadataSnapshot?.()?.manifestRegistry,
            reloadPlugins: plan.reloadPlugins,
          }),
        timeoutMs: MCP_RUNTIME_RELOAD_DISPOSE_TIMEOUT_MS,
        onWarn: params.logReload.warn,
        label: "bundle-mcp runtime disposal during config reload",
      });
    }

    if (plan.restartGmailWatcher) {
      const restartAbortController =
        params.createGmailRestartAbortController?.() ?? new AbortController();
      try {
        await params.stopPostReadySidecars?.();
        if (!restartAbortController.signal.aborted) {
          const [{ stopGmailWatcher }, { startGmailWatcherWithLogs }] = await Promise.all([
            import("../hooks/gmail-watcher.js"),
            import("../hooks/gmail-watcher-lifecycle.js"),
          ]);
          if (!restartAbortController.signal.aborted) {
            await stopGmailWatcher().catch((err: unknown) => {
              params.logHooks.warn(`gmail watcher stop failed during reload: ${String(err)}`);
            });
          }
          if (!restartAbortController.signal.aborted) {
            await startGmailWatcherWithLogs({
              cfg: nextConfig,
              log: params.logHooks,
              signal: restartAbortController.signal,
              scheduler: params.scheduler,
              onSkipped: () =>
                params.logHooks.info(
                  "skipping gmail watcher restart (OPENCLAW_SKIP_GMAIL_WATCHER=1)",
                ),
            });
          }
        }
      } catch (err) {
        scheduleRecoveryRestart("gmail watcher reload", err);
      } finally {
        params.clearGmailRestartAbortController?.(restartAbortController);
      }
    }

    await restartGatewayChannels({
      params,
      nextConfig,
      channelsToRestart,
      restartChannelAccounts,
      activePluginChannelsAfterReload,
      shouldSkipChannelRestart,
      isLifecycleReloadAborted,
      getChannelAutostartSuppression,
      channelReloadTargets,
      scheduleRecoveryRestart,
    });

    if (shouldRefreshContextWindowCache(plan)) {
      try {
        await refreshContextWindowCache(nextConfig);
      } catch (err) {
        scheduleRecoveryRestart("context window cache reload", err);
      }
    }
    if (plan.hotReasons.length > 0) {
      params.logReload.info(`config hot reload applied (${plan.hotReasons.join(", ")})`);
    } else if (plan.noopPaths.length > 0) {
      params.logReload.info(`config change applied (dynamic reads: ${plan.noopPaths.join(", ")})`);
    }
    const status = recoveryRestartScheduled ? "applied-restart-required" : "applied";
    return pluginRuntimeApplication ? { status, runtime: pluginRuntimeApplication } : status;
  };

  return {
    ...restartCoordinator,
    applyHotReload,
    getDeferredChannelReloads,
  };
}
