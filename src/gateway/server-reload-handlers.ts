// Gateway hot-reload handlers.
// Applies config reload plans to hooks, cron, heartbeat, plugins, channels, and restarts.
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-tools.js";
import { getActiveBackgroundExecSessionCount } from "../agents/bash-process-registry.js";
import { refreshContextWindowCache } from "../agents/context.js";
import {
  getActiveEmbeddedRunCount,
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
} from "../agents/embedded-agent-runner/run-state.js";
import { loadModelCatalog, resetModelCatalogCache } from "../agents/model-catalog.js";
import {
  clearCurrentProviderAuthState,
  warmCurrentProviderAuthStateOffMainThread,
} from "../agents/model-provider-auth.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import type { CliDeps } from "../cli/deps.types.js";
import { isRestartEnabled } from "../config/commands.flags.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import {
  deferGatewayRestartUntilIdle,
  type GatewayRestartEmitter,
  type GatewayRestartIntent,
  type RestartDeferralHandle,
  resolveGatewayRestartDeferralTimeoutMs,
  setGatewaySigusr1RestartPolicy,
} from "../infra/restart.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import {
  getActiveGatewayRootWorkCount,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime-state.js";
import { getInspectableActiveTaskRestartBlockers } from "../tasks/task-registry.maintenance.js";
import { formatActiveTaskRestartBlocker } from "../tasks/task-restart-blocker.js";
import type { ChannelHealthMonitor } from "./channel-health-monitor.js";
import type { ChannelKind } from "./config-reload-plan.js";
import { startGatewayConfigReloader, type GatewayReloadPlan } from "./config-reload.js";
import { resolveHooksConfig } from "./hooks.js";
import type { GatewayCronReconciliation } from "./server-cron-reconciled.js";
import { buildGatewayCronService, type GatewayCronState } from "./server-cron.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";
import { markGatewayModelCatalogStaleForReload } from "./server-model-catalog.js";
import type { GatewayConfigReloaderHandle } from "./server-runtime-handles.js";
import {
  type GatewayChannelManager,
  startGatewayChannelHealthMonitor,
  startGatewayCronWithLogging,
} from "./server-runtime-services.js";
import {
  disconnectStaleSharedGatewayAuthClients,
  setCurrentSharedGatewaySessionGeneration,
  type SharedGatewayAuthClient,
  type SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";
import type { ActivateRuntimeSecrets } from "./server-startup-config.js";
import { resolveHookClientIpConfig } from "./server/hook-client-ip-config.js";
import type { HookClientIpConfig } from "./server/hooks-request-handler.js";

// When an in-process restart (SIGUSR1) fires while a deferred channel reload
// is waiting for active work to drain, the restart supersedes the reload.
// This abort generation lets the restart path cancel the deferred reload before both
// code paths race to start the same channel. Each createGatewayReloadHandlers call
// increments the generation so a new lifecycle never clears an abort intended for a
// previous lifecycle's deferred reload.
let currentReloadGeneration = 0;
let abortGeneration: number | undefined = undefined;
const RESTART_EMISSION_RETRY_MS = 1_000;

/** Signal any in-progress deferred channel reload to abort immediately. */
export function abortPendingChannelReloads(): void {
  abortGeneration = currentReloadGeneration;
}

type GatewayHotReloadState = {
  hooksConfig: ReturnType<typeof resolveHooksConfig>;
  hookClientIpConfig: HookClientIpConfig;
  heartbeatRunner: HeartbeatRunner;
  cronState: GatewayCronState;
  channelHealthMonitor: ChannelHealthMonitor | null;
};

async function activateSecretsRuntimeSnapshot(
  snapshot: PreparedSecretsRuntimeSnapshot,
): Promise<void> {
  const runtime = await import("../secrets/runtime.js");
  runtime.activateSecretsRuntimeSnapshot(snapshot);
}

type GatewayReloadLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

type GatewayGmailRestartAbortController = {
  abort: () => void;
  signal: AbortSignal;
};

type GatewayHotReloadPublication = {
  publish: (commit: () => Promise<void>, isCommitted: () => boolean) => Promise<void>;
};

type GatewayRestartTransactionState = "pending" | "committed" | "rejected";

type GatewayRestartTransactionResult = {
  status: "accepted" | "recovery-pending";
  settle: (state: Exclude<GatewayRestartTransactionState, "pending">) => void;
};

export class GatewayHotReloadCancelledError extends Error {
  constructor() {
    super("config hot reload cancelled by in-process restart");
    this.name = "GatewayHotReloadCancelledError";
  }
}

export class GatewayHotReloadRecoveryError extends Error {
  constructor(surface: string) {
    super(`config hot reload committed but could not schedule recovery for ${surface}`);
    this.name = "GatewayHotReloadRecoveryError";
  }
}

class GatewayHotReloadStaleSecretsError extends Error {
  constructor() {
    super("runtime secrets changed while config hot reload was deferred");
    this.name = "GatewayHotReloadStaleSecretsError";
  }
}

export type GatewayPluginReloadResult = {
  restartChannels: ReadonlySet<ChannelKind>;
  activeChannels: ReadonlySet<ChannelKind>;
  /** Set when the reload was cancelled mid-flight (e.g. by an in-process restart). */
  cancelled?: boolean;
};

const MCP_RUNTIME_RELOAD_DISPOSE_TIMEOUT_MS = 5_000;
const CHANNEL_RELOAD_DEFERRAL_POLL_MS = 500;
const CHANNEL_RELOAD_STILL_PENDING_WARN_MS = 30_000;

function resetPreparedModelRuntimeStateForHotReload(): void {
  resetModelCatalogCache();
  clearCurrentProviderAuthState();
  markGatewayModelCatalogStaleForReload();
}

function shouldRefreshContextWindowCache(plan: GatewayReloadPlan): boolean {
  return (
    plan.reloadPlugins ||
    plan.changedPaths.some(
      (path) =>
        path === "models" ||
        path.startsWith("models.") ||
        path === "agents" ||
        path === "agents.defaults" ||
        path === "agents.list" ||
        path.startsWith("agents.list.") ||
        path === "agents.defaults.workspace" ||
        path.startsWith("agents.defaults.workspace."),
    )
  );
}

async function disposeMcpRuntimesWithTimeout(params: {
  dispose: () => Promise<void>;
  timeoutMs: number;
  onWarn: (message: string) => void;
  label: string;
}) {
  // MCP runtime disposal may need async provider cleanup. Bound it so config
  // reload can proceed and report the stale runtime risk.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disposePromise = params.dispose().catch((error: unknown) => {
    params.onWarn(`${params.label} failed: ${String(error)}`);
  });
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), params.timeoutMs);
    timer.unref?.();
  });
  const result = await Promise.race([disposePromise.then(() => "done" as const), timeoutPromise]);
  if (timer) {
    clearTimeout(timer);
  }
  if (result === "timeout") {
    params.onWarn(`${params.label} exceeded ${params.timeoutMs}ms; continuing`);
  }
}

async function collectChannelOperationFailures(params: {
  channels: Iterable<ChannelKind>;
  run: (channel: ChannelKind) => Promise<void>;
  onFailure: (channel: ChannelKind, err: unknown) => void;
}): Promise<ChannelKind[]> {
  const failures: ChannelKind[] = [];
  for (const channel of params.channels) {
    try {
      await params.run(channel);
    } catch (err) {
      failures.push(channel);
      params.onFailure(channel, err);
    }
  }
  return failures;
}

type GatewayReloadHandlerParams = {
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  getState: () => GatewayHotReloadState;
  setState: (state: GatewayHotReloadState) => void;
  startChannel: GatewayChannelManager["startChannel"];
  stopChannel: GatewayChannelManager["stopChannel"];
  getChannelAutostartSuppression?: GatewayChannelManager["getAutostartSuppression"];
  stopPostReadySidecars?: () => Promise<void> | void;
  reloadPlugins: (params: {
    nextConfig: OpenClawConfig;
    changedPaths: readonly string[];
    beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
    commitRuntime: () => Promise<void>;
    isAborted?: () => boolean;
  }) => Promise<GatewayPluginReloadResult>;
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  logCron: { error: (msg: string) => void };
  logReload: GatewayReloadLog;
  cronReconciliation: GatewayCronReconciliation;
  createHealthMonitor: (config: OpenClawConfig) => ChannelHealthMonitor | null;
  createGmailRestartAbortController?: () => GatewayGmailRestartAbortController;
  clearGmailRestartAbortController?: (controller: GatewayGmailRestartAbortController) => void;
  onCronRestart?: () => void;
  requestRecoveryRestart?: GatewayRestartEmitter;
};

type ManagedGatewayConfigReloaderParams = Omit<
  GatewayReloadHandlerParams,
  "createHealthMonitor" | "logReload"
> & {
  minimalTestGateway: boolean;
  initialConfig: OpenClawConfig;
  initialCompareConfig?: OpenClawConfig;
  initialInternalWriteHash: string | null;
  watchPath: string;
  readSnapshot: typeof import("../config/config.js").readConfigFileSnapshot;
  promoteSnapshot: typeof import("../config/config.js").promoteConfigSnapshotToLastKnownGood;
  subscribeToWrites: typeof import("../config/config.js").registerConfigWriteListener;
  logReload: GatewayReloadLog & {
    error: (msg: string) => void;
  };
  channelManager: GatewayChannelManager;
  activateRuntimeSecrets: ActivateRuntimeSecrets;
  resolveSharedGatewaySessionGenerationForConfig: (config: OpenClawConfig) => string | undefined;
  sharedGatewaySessionGenerationState: SharedGatewaySessionGenerationState;
  clients: Iterable<SharedGatewayAuthClient>;
  reconcileTerminalSessions: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void;
  commitTerminalConfig: () => void;
};

export function createGatewayReloadHandlers(params: GatewayReloadHandlerParams) {
  const myGeneration = ++currentReloadGeneration;

  const getActiveCounts = () => {
    const queueSize = getTotalQueueSize();
    const pendingReplies = getTotalPendingReplies();
    const embeddedRuns = getActiveEmbeddedRunCount();
    const backgroundExecSessions = getActiveBackgroundExecSessionCount();
    const rootRequests = getActiveGatewayRootWorkCount({ excludeCurrent: true });
    const activeTasks = getInspectableActiveTaskRestartBlockers().length;
    return {
      queueSize,
      pendingReplies,
      embeddedRuns,
      backgroundExecSessions,
      rootRequests,
      activeTasks,
      totalActive:
        queueSize +
        pendingReplies +
        embeddedRuns +
        backgroundExecSessions +
        rootRequests +
        activeTasks,
    };
  };
  const formatActiveDetails = (counts: ReturnType<typeof getActiveCounts>) => {
    const details = [];
    if (counts.queueSize > 0) {
      details.push(`${counts.queueSize} operation(s)`);
    }
    if (counts.pendingReplies > 0) {
      details.push(`${counts.pendingReplies} reply(ies)`);
    }
    if (counts.embeddedRuns > 0) {
      details.push(`${counts.embeddedRuns} embedded run(s)`);
    }
    if (counts.backgroundExecSessions > 0) {
      details.push(`${counts.backgroundExecSessions} background exec session(s)`);
    }
    if (counts.rootRequests > 0) {
      details.push(`${counts.rootRequests} gateway request(s)`);
    }
    if (counts.activeTasks > 0) {
      details.push(`${counts.activeTasks} background task run(s)`);
    }
    return details;
  };
  const formatTaskBlockers = () => {
    const blockers = getInspectableActiveTaskRestartBlockers();
    if (blockers.length === 0) {
      return null;
    }
    const shown = blockers.slice(0, 8).map(formatActiveTaskRestartBlocker);
    const omitted = blockers.length - shown.length;
    return omitted > 0 ? `${shown.join("; ")}; +${omitted} more` : shown.join("; ");
  };
  const collectActiveRestartSessionKeys = () => {
    return new Set<string>(listActiveEmbeddedRunSessionKeys());
  };
  const collectActiveRestartSessionIds = () => {
    return new Set<string>(listActiveEmbeddedRunSessionIds());
  };
  const markActiveMainSessionsForRestart = async (nextConfig: OpenClawConfig, reason: string) => {
    const sessionKeys = collectActiveRestartSessionKeys();
    const sessionIds = collectActiveRestartSessionIds();
    if (sessionKeys.size === 0 && sessionIds.size === 0) {
      return;
    }
    const { markRestartAbortedMainSessions } =
      await import("../agents/main-session-restart-recovery.js");
    await markRestartAbortedMainSessions({
      cfg: nextConfig,
      additionalCfgs: [getRuntimeConfig()],
      sessionKeys,
      sessionIds,
      reason,
    });
  };
  const waitForActiveWorkBeforeChannelReload = async (
    channels: Iterable<ChannelKind>,
    nextConfig: OpenClawConfig,
  ): Promise<boolean> => {
    // Returns true when the wait was cancelled (in-process restart supersedes),
    // false when active work drained or timed out and channel reload may proceed.
    const initial = getActiveCounts();
    if (initial.totalActive <= 0) {
      return false;
    }
    const channelNames = [...channels].join(", ");
    const initialDetails = formatActiveDetails(initial);
    params.logReload.warn(
      `config change requires channel reload (${channelNames}) — deferring until ${initialDetails.join(
        ", ",
      )} complete`,
    );
    const timeoutMs = resolveGatewayRestartDeferralTimeoutMs(
      nextConfig.gateway?.reload?.deferralTimeoutMs,
    );
    const startedAt = Date.now();
    let nextStillPendingAt = startedAt + CHANNEL_RELOAD_STILL_PENDING_WARN_MS;
    while (true) {
      if (abortGeneration !== undefined && myGeneration <= abortGeneration) {
        return true;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CHANNEL_RELOAD_DEFERRAL_POLL_MS);
        timer.unref?.();
      });
      if (abortGeneration !== undefined && myGeneration <= abortGeneration) {
        return true;
      }
      const current = getActiveCounts();
      if (current.totalActive <= 0) {
        return false;
      }
      const elapsedMs = Date.now() - startedAt;
      if (timeoutMs !== undefined && elapsedMs >= timeoutMs) {
        const remaining = formatActiveDetails(current);
        params.logReload.warn(
          `channel reload timeout after ${elapsedMs}ms with ${remaining.join(
            ", ",
          )} still active; reloading channels anyway`,
        );
        return false;
      }
      if (Date.now() >= nextStillPendingAt) {
        const remaining = formatActiveDetails(current);
        params.logReload.warn(
          `channel reload still deferred after ${elapsedMs}ms with ${remaining.join(", ")} active`,
        );
        nextStillPendingAt = Date.now() + CHANNEL_RELOAD_STILL_PENDING_WARN_MS;
      }
    }
  };

  const applyHotReload = async (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    publication?: GatewayHotReloadPublication,
  ): Promise<void> => {
    const state = params.getState();
    const nextState = { ...state };

    resetPreparedModelRuntimeStateForHotReload();

    if (plan.reloadHooks) {
      try {
        nextState.hooksConfig = resolveHooksConfig(nextConfig);
      } catch (err) {
        params.logHooks.warn(`hooks config reload failed: ${String(err)}`);
        throw err;
      }
    }
    nextState.hookClientIpConfig = resolveHookClientIpConfig(nextConfig);

    if (plan.restartCron) {
      nextState.cronState = buildGatewayCronService({
        cfg: nextConfig,
        deps: params.deps,
        broadcast: params.broadcast,
      });
    }

    resetDirectoryCache();

    const channelsToRestart = new Set(plan.restartChannels);
    const channelsStoppedBeforePluginReload = new Set<ChannelKind>();
    let activePluginChannelsAfterReload: ReadonlySet<ChannelKind> | null = null;
    let pluginReloadAborted = false;
    const isPluginReloadAborted = () =>
      pluginReloadAborted || (abortGeneration !== undefined && myGeneration <= abortGeneration);
    let runtimeCommitted = false;
    let recoveryRestartScheduled = false;
    const shouldSkipChannelRestart = () =>
      isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
      isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
    const getChannelAutostartSuppression = () => params.getChannelAutostartSuppression?.() ?? null;
    const logSuppressedChannelRestart = (
      channels: ReadonlySet<ChannelKind>,
      action: string,
    ): void => {
      const suppression = getChannelAutostartSuppression();
      if (!suppression) {
        return;
      }
      params.logChannels.info(
        `${action} suppressed by crash-loop breaker for channels: ${[...channels].join(", ")}`,
      );
    };
    const commitRuntime = async () => {
      if (runtimeCommitted) {
        return;
      }
      if (!params.requestRecoveryRestart) {
        throw new Error("config hot reload recovery is unavailable");
      }
      const commit = async () => {
        if (plan.restartHeartbeat) {
          nextState.heartbeatRunner.updateConfig(nextConfig);
        }
        params.setState(nextState);
        runtimeCommitted = true;
        setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
        if (plan.restartCron) {
          params.cronReconciliation.invalidate();
          params.onCronRestart?.();
          state.cronState.cron.stop();
          state.cronState.stopExitWatchers?.();
          startGatewayCronWithLogging({
            cronState: nextState.cronState,
            cronReconciliation: params.cronReconciliation,
            reason: "reload",
            config: nextConfig,
            afterStart: nextState.cronState.reconcileExitWatchers,
            logCron: params.logCron,
            onStartError: (err) => {
              if (
                myGeneration !== currentReloadGeneration ||
                params.getState().cronState !== nextState.cronState
              ) {
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
      if (publication) {
        await publication.publish(commit, () => runtimeCommitted);
      } else {
        await commit();
      }
    };
    const scheduleRecoveryRestart = (surface: string, err?: unknown) => {
      const detail = err === undefined ? "" : `: ${formatErrorMessage(err)}`;
      params.logReload.warn(`${surface} failed after config commit${detail}; restarting gateway`);
      if (recoveryRestartScheduled) {
        return;
      }
      try {
        // Reuse the config-restart path: it excludes this reload root while
        // draining other work and fences signal delivery until restart takes over.
        const restartTransaction = requestGatewayRestart(
          {
            ...plan,
            restartGateway: true,
            restartReasons: [`hot reload recovery: ${surface}`],
          },
          nextConfig,
        );
        restartTransaction.settle("committed");
        // Immediate emission failure already owns a lifecycle retry. The runtime
        // is committed, so keep this transaction accepted while that retry runs.
        recoveryRestartScheduled = true;
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
    if (plan.reloadPlugins) {
      const restartStoppedPluginChannels = async (reason: string) =>
        await collectChannelOperationFailures({
          channels: [...channelsStoppedBeforePluginReload],
          run: async (channel) => {
            params.logChannels.info(`restarting ${channel} channel after ${reason}`);
            await params.startChannel(channel);
            channelsStoppedBeforePluginReload.delete(channel);
          },
          onFailure: (channel, err) => {
            params.logChannels.error(
              `failed to restart ${channel} channel after ${reason}: ${formatErrorMessage(err)}`,
            );
          },
        });
      const stopChannelsBeforePluginReplace = async (channels: ReadonlySet<ChannelKind>) => {
        for (const channel of channels) {
          channelsToRestart.add(channel);
        }
        if (channelsToRestart.size === 0 || shouldSkipChannelRestart()) {
          return;
        }
        if (await waitForActiveWorkBeforeChannelReload(channelsToRestart, nextConfig)) {
          params.logChannels.info(
            "channel reload before plugin replace cancelled by in-process restart",
          );
          pluginReloadAborted = true;
          return;
        }
        const stopFailures = await collectChannelOperationFailures({
          channels: channelsToRestart,
          run: async (channel) => {
            if (channelsStoppedBeforePluginReload.has(channel)) {
              return;
            }
            params.logChannels.info(`stopping ${channel} channel before plugin reload`);
            channelsStoppedBeforePluginReload.add(channel);
            await params.stopChannel(channel, undefined, { manual: false });
          },
          onFailure: (channel, err) => {
            params.logChannels.error(
              `failed to stop ${channel} channel before plugin reload: ${formatErrorMessage(err)}`,
            );
          },
        });
        if (stopFailures.length > 0) {
          const rollbackFailures = await restartStoppedPluginChannels(
            "failed plugin reload pre-stop",
          );
          const rollbackSuffix =
            rollbackFailures.length > 0
              ? `; rollback restart failed for: ${rollbackFailures.join(", ")}`
              : "";
          throw new Error(
            `failed to stop channels before plugin reload: ${stopFailures.join(", ")}${rollbackSuffix}`,
          );
        }
      };
      if (!pluginReloadAborted) {
        let pluginReloadResult: GatewayPluginReloadResult;
        try {
          pluginReloadResult = await params.reloadPlugins({
            nextConfig,
            changedPaths: plan.changedPaths,
            beforeReplace: stopChannelsBeforePluginReplace,
            commitRuntime,
            isAborted: isPluginReloadAborted,
          });
        } catch (err) {
          if (!runtimeCommitted) {
            const rollbackFailures = await restartStoppedPluginChannels(
              "failed plugin runtime publication",
            );
            if (rollbackFailures.length > 0) {
              throw new Error(
                `${formatErrorMessage(err)}; rollback restart failed for: ${rollbackFailures.join(", ")}`,
                { cause: err },
              );
            }
            throw err;
          }
          scheduleRecoveryRestart("plugin runtime reload", err);
          return;
        }
        if (pluginReloadResult.cancelled) {
          pluginReloadAborted = true;
          const rollbackFailures = await restartStoppedPluginChannels(
            "cancelled plugin runtime publication",
          );
          if (rollbackFailures.length > 0) {
            throw new Error(
              `plugin reload cancellation rollback failed for: ${rollbackFailures.join(", ")}`,
            );
          }
        }
        // beforeReplace may have set pluginReloadAborted inside reloadPlugins;
        // skip metadata/runtime updates when the reload was cancelled mid-flight.
        if (!pluginReloadAborted) {
          for (const channel of pluginReloadResult.restartChannels) {
            channelsToRestart.add(channel);
          }
          activePluginChannelsAfterReload = pluginReloadResult.activeChannels;
          resetPreparedModelRuntimeStateForHotReload();
        }
      }
    }

    if (!plan.reloadPlugins && channelsToRestart.size > 0 && !shouldSkipChannelRestart()) {
      pluginReloadAborted = await waitForActiveWorkBeforeChannelReload(
        channelsToRestart,
        nextConfig,
      );
    }
    if (pluginReloadAborted) {
      params.logChannels.info("channel restart cancelled by in-process restart");
      throw new GatewayHotReloadCancelledError();
    }
    try {
      await commitRuntime();
    } catch (err) {
      if (!runtimeCommitted) {
        throw err;
      }
      scheduleRecoveryRestart("runtime commit", err);
      return;
    }

    if (plan.restartHealthMonitor) {
      try {
        nextState.channelHealthMonitor = params.createHealthMonitor(nextConfig);
        params.setState(nextState);
        state.channelHealthMonitor?.stop();
      } catch (err) {
        scheduleRecoveryRestart("health monitor reload", err);
      }
    }

    if (plan.disposeMcpRuntimes) {
      await disposeMcpRuntimesWithTimeout({
        dispose: disposeAllSessionMcpRuntimes,
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
              isCancelled: () => restartAbortController.signal.aborted,
              signal: restartAbortController.signal,
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

    if (channelsToRestart.size > 0) {
      if (shouldSkipChannelRestart()) {
        params.logChannels.info(
          "skipping channel reload (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
        );
      } else if (getChannelAutostartSuppression()) {
        const cancelledByRestart = pluginReloadAborted;
        if (cancelledByRestart) {
          params.logChannels.info("channel restart cancelled by in-process restart");
        } else {
          const stopFailures = await collectChannelOperationFailures({
            channels: channelsToRestart,
            run: async (channel) => {
              if (plan.reloadPlugins && activePluginChannelsAfterReload?.has(channel) === false) {
                return;
              }
              if (channelsStoppedBeforePluginReload.has(channel)) {
                return;
              }
              params.logChannels.info(`stopping ${channel} channel before suppressed hot reload`);
              await params.stopChannel(channel, undefined, { manual: false });
            },
            onFailure: (channel, err) => {
              params.logChannels.error(
                `failed to stop ${channel} channel during suppressed hot reload: ${formatErrorMessage(
                  err,
                )}`,
              );
            },
          });
          if (stopFailures.length > 0) {
            scheduleRecoveryRestart(`channel stop (${stopFailures.join(", ")})`);
          }
          logSuppressedChannelRestart(channelsToRestart, "channel restart during hot reload");
        }
      } else {
        const cancelledByRestart = pluginReloadAborted;
        if (cancelledByRestart) {
          params.logChannels.info("channel restart cancelled by in-process restart");
        } else {
          const restartChannel = async (name: ChannelKind) => {
            if (plan.reloadPlugins && activePluginChannelsAfterReload?.has(name) === false) {
              return;
            }
            params.logChannels.info(`restarting ${name} channel`);
            if (!channelsStoppedBeforePluginReload.has(name)) {
              await params.stopChannel(name, undefined, { manual: false });
            }
            if (abortGeneration !== undefined && myGeneration <= abortGeneration) {
              return;
            }
            await params.startChannel(name);
          };
          const restartFailures = await collectChannelOperationFailures({
            channels: channelsToRestart,
            run: restartChannel,
            onFailure: (channel, err) => {
              params.logChannels.error(
                `failed to restart ${channel} channel during hot reload: ${formatErrorMessage(err)}`,
              );
            },
          });
          if (restartFailures.length > 0) {
            scheduleRecoveryRestart(`channel restart (${restartFailures.join(", ")})`);
          }
        }
      }
    }

    try {
      applyGatewayLaneConcurrency(nextConfig);
    } catch (err) {
      scheduleRecoveryRestart("lane concurrency reload", err);
    }

    if (shouldRefreshContextWindowCache(plan)) {
      try {
        await refreshContextWindowCache(nextConfig);
        // Provider discovery is best-effort; a slow hook must not hold hot reload open.
        void loadModelCatalog({ config: nextConfig });
      } catch (err) {
        scheduleRecoveryRestart("context window cache reload", err);
      }
    }
    void warmCurrentProviderAuthStateOffMainThread(nextConfig).catch((err: unknown) => {
      params.logReload.warn(`provider auth state rewarm failed: ${String(err)}`);
    });

    if (plan.hotReasons.length > 0) {
      params.logReload.info(`config hot reload applied (${plan.hotReasons.join(", ")})`);
    } else if (plan.noopPaths.length > 0) {
      params.logReload.info(`config change applied (dynamic reads: ${plan.noopPaths.join(", ")})`);
    }
  };

  let restartPending = false;
  let restartRetryStopped = false;
  let restartRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let restartDeferral: RestartDeferralHandle | null = null;
  let restartRequestGeneration = 0;
  let restartRequestTransaction: { state: GatewayRestartTransactionState } | null = null;

  const supersedeRestartRequest = () => {
    restartRequestGeneration += 1;
    restartPending = false;
    restartDeferral?.cancel();
    restartDeferral = null;
    if (restartRetryTimer) {
      clearTimeout(restartRetryTimer);
      restartRetryTimer = null;
    }
    restartRequestTransaction = null;
  };

  const stopRestartRetries = () => {
    restartRetryStopped = true;
    supersedeRestartRequest();
  };

  const scheduleRestartEmissionRetry = (retry: {
    reason: string;
    intent?: GatewayRestartIntent;
    requestGeneration: number;
  }) => {
    if (
      restartRetryStopped ||
      restartRetryTimer ||
      retry.requestGeneration !== restartRequestGeneration ||
      myGeneration !== currentReloadGeneration
    ) {
      return;
    }
    // Retry the exact failed emission. Re-entering request planning would start
    // a fresh idle deferral and discard a timeout's force/deadline decision.
    restartPending = true;
    restartRetryTimer = setTimeout(() => {
      restartRetryTimer = null;
      if (
        restartRetryStopped ||
        retry.requestGeneration !== restartRequestGeneration ||
        myGeneration !== currentReloadGeneration
      ) {
        return;
      }
      restartPending = false;
      const emitResult = params.requestRecoveryRestart?.(retry.reason, retry.intent);
      if (!emitResult || emitResult.status === "failed") {
        scheduleRestartEmissionRetry(retry);
      }
    }, RESTART_EMISSION_RETRY_MS);
    restartRetryTimer.unref?.();
  };

  const retireRejectedRestartRequest = () => {
    if (restartRequestTransaction?.state === "rejected") {
      supersedeRestartRequest();
    }
  };

  const requestGatewayRestartForGeneration = (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    requestGeneration: number,
  ): boolean => {
    const reasons = plan.restartReasons.length
      ? plan.restartReasons.join(", ")
      : plan.changedPaths.join(", ");
    const restartReason = `config reload: ${reasons}`;

    if (!params.requestRecoveryRestart) {
      params.logReload.warn("gateway restart recovery handler unavailable; restart skipped");
      return false;
    }
    const requestRecoveryRestart = params.requestRecoveryRestart;

    const active = getActiveCounts();

    if (active.totalActive > 0) {
      // Avoid spinning up duplicate polling loops from repeated config changes.
      if (restartPending) {
        params.logReload.info(
          `config change requires gateway restart (${reasons}) — already waiting for operations to complete`,
        );
        return true;
      }
      restartPending = true;
      const initialDetails = formatActiveDetails(active);
      params.logReload.warn(
        `config change requires gateway restart (${reasons}) — deferring until ${initialDetails.join(", ")} complete`,
      );
      const taskBlockers = formatTaskBlockers();
      if (taskBlockers) {
        params.logReload.warn(`restart blocked by active background task run(s): ${taskBlockers}`);
      }

      let failedEmission: { reason: string; intent?: GatewayRestartIntent } | undefined;
      restartDeferral = deferGatewayRestartUntilIdle({
        getPendingCount: () => getActiveCounts().totalActive,
        maxWaitMs: resolveGatewayRestartDeferralTimeoutMs(
          nextConfig.gateway?.reload?.deferralTimeoutMs,
        ),
        timeoutIntent: { force: true, reason: "config reload forced restart" },
        reason: restartReason,
        emitHooks: {
          beforeEmit: () =>
            markActiveMainSessionsForRestart(nextConfig, "config reload forced restart"),
          emitRestart: (reason, intent) => {
            if (requestGeneration !== restartRequestGeneration) {
              return { status: "coalesced" };
            }
            const resolvedReason = reason ?? restartReason;
            const emitResult = requestRecoveryRestart(resolvedReason, intent);
            failedEmission =
              emitResult.status === "failed" ? { reason: resolvedReason, intent } : undefined;
            return emitResult;
          },
          afterEmitFailed: async () => {
            if (requestGeneration !== restartRequestGeneration || !failedEmission) {
              return;
            }
            params.logReload.warn("gateway restart recovery emission failed; retrying");
            scheduleRestartEmissionRetry({
              ...failedEmission,
              requestGeneration,
            });
          },
        },
        hooks: {
          onReady: () => {
            restartPending = false;
            restartDeferral = null;
            params.logReload.info("all operations and replies completed; restarting gateway now");
          },
          onStillPending: (_pending, elapsedMs) => {
            const remaining = formatActiveDetails(getActiveCounts());
            const taskBlockersValue = formatTaskBlockers();
            params.logReload.warn(
              `restart still deferred after ${elapsedMs}ms with ${remaining.join(", ")} active${
                taskBlockersValue ? ` (${taskBlockersValue})` : ""
              }`,
            );
          },
          onTimeout: (_pending, elapsedMs) => {
            const remaining = formatActiveDetails(getActiveCounts());
            const taskBlockersLocal = formatTaskBlockers();
            restartPending = false;
            restartDeferral = null;
            params.logReload.warn(
              `restart timeout after ${elapsedMs}ms with ${remaining.join(", ")} still active${
                taskBlockersLocal ? ` (${taskBlockersLocal})` : ""
              }; forcing restart`,
            );
          },
          onCheckError: (err) => {
            restartPending = false;
            restartDeferral = null;
            params.logReload.warn(
              `restart deferral check failed (${String(err)}); restarting gateway now`,
            );
          },
        },
      });
      setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
      return true;
    }
    // No active operations or pending replies, restart immediately
    params.logReload.warn(`config change requires gateway restart (${reasons})`);
    // The managed reloader owns independent root admission until onRestart
    // returns. Extend that fence across signal delivery until the run loop
    // atomically promotes it to one-way restart drain.
    const emitResult = requestRecoveryRestart(restartReason);
    if (emitResult.status === "failed") {
      params.logReload.warn("gateway restart recovery emission failed");
      scheduleRestartEmissionRetry({
        reason: restartReason,
        requestGeneration,
      });
      return false;
    }
    if (emitResult.status === "coalesced") {
      params.logReload.info("gateway restart already scheduled; skipping duplicate signal");
    }
    setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
    return true;
  };

  const requestGatewayRestart = (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
  ): GatewayRestartTransactionResult => {
    // Only another restart requirement supersedes accepted restart work. A
    // duplicate, hot-only, or failed config transaction must preserve it.
    supersedeRestartRequest();
    const transaction = { state: "pending" as GatewayRestartTransactionState };
    restartRequestTransaction = transaction;
    const accepted = requestGatewayRestartForGeneration(plan, nextConfig, restartRequestGeneration);
    return {
      status: accepted ? "accepted" : "recovery-pending",
      settle: (state) => {
        if (transaction.state === "pending") {
          transaction.state = state;
        }
      },
    };
  };

  return {
    applyHotReload,
    requestGatewayRestart,
    retireRejectedRestartRequest,
    stopRestartRetries,
  };
}

export function startManagedGatewayConfigReloader(
  params: ManagedGatewayConfigReloaderParams,
): GatewayConfigReloaderHandle {
  if (params.minimalTestGateway) {
    return { stop: async () => {} };
  }

  let stopped = false;
  let activeGmailRestartAbortController: GatewayGmailRestartAbortController | null = null;
  const abortActiveGmailRestart = () => {
    activeGmailRestartAbortController?.abort();
    activeGmailRestartAbortController = null;
  };
  const createGmailRestartAbortController = (): GatewayGmailRestartAbortController => {
    abortActiveGmailRestart();
    const abortController = new AbortController();
    if (stopped) {
      abortController.abort();
      return abortController;
    }
    activeGmailRestartAbortController = abortController;
    return abortController;
  };
  const {
    applyHotReload,
    requestGatewayRestart,
    retireRejectedRestartRequest,
    stopRestartRetries,
  } = createGatewayReloadHandlers({
    deps: params.deps,
    broadcast: params.broadcast,
    getState: params.getState,
    setState: params.setState,
    startChannel: params.startChannel,
    stopChannel: params.stopChannel,
    getChannelAutostartSuppression: params.getChannelAutostartSuppression,
    stopPostReadySidecars: params.stopPostReadySidecars,
    reloadPlugins: params.reloadPlugins,
    logHooks: params.logHooks,
    logChannels: params.logChannels,
    logCron: params.logCron,
    logReload: params.logReload,
    cronReconciliation: params.cronReconciliation,
    createGmailRestartAbortController,
    clearGmailRestartAbortController: (abortController) => {
      if (activeGmailRestartAbortController === abortController) {
        activeGmailRestartAbortController = null;
      }
    },
    ...(params.onCronRestart ? { onCronRestart: params.onCronRestart } : {}),
    ...(params.requestRecoveryRestart
      ? { requestRecoveryRestart: params.requestRecoveryRestart }
      : {}),
    createHealthMonitor: (config) =>
      startGatewayChannelHealthMonitor({
        cfg: config,
        channelManager: params.channelManager,
      }),
  });

  const configReloader = startGatewayConfigReloader({
    initialConfig: params.initialConfig,
    initialCompareConfig: params.initialCompareConfig,
    initialInternalWriteHash: params.initialInternalWriteHash,
    runTransaction: runWithGatewayIndependentRootWorkAdmission,
    readSnapshot: params.readSnapshot,
    promoteSnapshot: async (snapshot, _reason) => await params.promoteSnapshot(snapshot),
    subscribeToWrites: params.subscribeToWrites,
    onConfigChange: (plan, nextConfig) => params.reconcileTerminalSessions(plan, nextConfig),
    onConfigAccepted: retireRejectedRestartRequest,
    onConfigApplied: () => params.commitTerminalConfig(),
    onNoopConfigCommit: async (_plan, nextConfig) => {
      await params.activateRuntimeSecrets(nextConfig, {
        reason: "reload",
        activate: true,
      });
    },
    onHotReload: async (plan, nextConfig) => {
      // A deferred channel/plugin reload can overlap secrets.reload. Retry from
      // preparation unless the same active snapshot still owns publication.
      for (;;) {
        const previousSnapshot = getActiveSecretsRuntimeSnapshot();
        const previousSnapshotRevision = getActiveSecretsRuntimeSnapshotRevision();
        const previousSharedGatewaySessionGeneration =
          params.sharedGatewaySessionGenerationState.current;
        const prepared = await params.activateRuntimeSecrets(nextConfig, {
          reason: "reload",
          activate: false,
        });
        if (getActiveSecretsRuntimeSnapshotRevision() !== previousSnapshotRevision) {
          continue;
        }
        const nextSharedGatewaySessionGeneration =
          params.resolveSharedGatewaySessionGenerationForConfig(prepared.config);
        const sharedGatewaySessionGenerationChanged =
          previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration;
        let runtimeSecretsPublished = false;
        let publishedSnapshotRevision: number | null = null;
        try {
          await applyHotReload(plan, prepared.config, {
            publish: async (commit, isCommitted) => {
              const publishRuntime = async () => {
                runtimeSecretsPublished = true;
                publishedSnapshotRevision = getActiveSecretsRuntimeSnapshotRevision();
                params.sharedGatewaySessionGenerationState.current =
                  nextSharedGatewaySessionGeneration;
                if (sharedGatewaySessionGenerationChanged) {
                  disconnectStaleSharedGatewayAuthClients({
                    clients: params.clients,
                    expectedGeneration: nextSharedGatewaySessionGeneration,
                  });
                }
                try {
                  await commit();
                } catch (err) {
                  if (!isCommitted()) {
                    if (previousSnapshot) {
                      await activateSecretsRuntimeSnapshot(previousSnapshot);
                    } else {
                      clearSecretsRuntimeSnapshot();
                    }
                    if (previousSnapshot && shouldRefreshContextWindowCache(plan)) {
                      await refreshContextWindowCache(previousSnapshot.config);
                    }
                    params.sharedGatewaySessionGenerationState.current =
                      previousSharedGatewaySessionGeneration;
                    if (sharedGatewaySessionGenerationChanged) {
                      disconnectStaleSharedGatewayAuthClients({
                        clients: params.clients,
                        expectedGeneration: previousSharedGatewaySessionGeneration,
                      });
                    }
                    runtimeSecretsPublished = false;
                  }
                  throw err;
                }
              };
              const activateIfCurrent =
                params.activateRuntimeSecrets.activatePreparedSnapshotIfCurrent;
              if (activateIfCurrent) {
                const activated = await activateIfCurrent(
                  prepared,
                  previousSnapshotRevision,
                  {
                    reason: "reload",
                    activate: true,
                  },
                  publishRuntime,
                );
                if (!activated) {
                  throw new GatewayHotReloadStaleSecretsError();
                }
              } else {
                if (getActiveSecretsRuntimeSnapshotRevision() !== previousSnapshotRevision) {
                  throw new GatewayHotReloadStaleSecretsError();
                }
                if (params.activateRuntimeSecrets.activatePreparedSnapshot) {
                  await params.activateRuntimeSecrets.activatePreparedSnapshot(prepared, {
                    reason: "reload",
                    activate: true,
                  });
                } else {
                  await activateSecretsRuntimeSnapshot(prepared);
                }
                await publishRuntime();
              }
            },
          });
        } catch (err) {
          if (err instanceof GatewayHotReloadStaleSecretsError) {
            continue;
          }
          if (err instanceof GatewayHotReloadRecoveryError) {
            throw err;
          }
          if (runtimeSecretsPublished) {
            const activateIfCurrent =
              params.activateRuntimeSecrets.activatePreparedSnapshotIfCurrent;
            let restored = false;
            if (previousSnapshot && publishedSnapshotRevision !== null && activateIfCurrent) {
              restored = Boolean(
                await activateIfCurrent(previousSnapshot, publishedSnapshotRevision, {
                  reason: "reload",
                  activate: true,
                }),
              );
            } else if (
              publishedSnapshotRevision !== null &&
              getActiveSecretsRuntimeSnapshotRevision() === publishedSnapshotRevision
            ) {
              if (previousSnapshot) {
                await activateSecretsRuntimeSnapshot(previousSnapshot);
              } else {
                clearSecretsRuntimeSnapshot();
              }
              restored = true;
            }
            if (restored) {
              if (previousSnapshot && shouldRefreshContextWindowCache(plan)) {
                await refreshContextWindowCache(previousSnapshot.config);
              }
              params.sharedGatewaySessionGenerationState.current =
                previousSharedGatewaySessionGeneration;
              if (sharedGatewaySessionGenerationChanged) {
                disconnectStaleSharedGatewayAuthClients({
                  clients: params.clients,
                  expectedGeneration: previousSharedGatewaySessionGeneration,
                });
              }
            }
          }
          throw err;
        }
        if (
          publishedSnapshotRevision !== null &&
          getActiveSecretsRuntimeSnapshotRevision() === publishedSnapshotRevision
        ) {
          setCurrentSharedGatewaySessionGeneration(
            params.sharedGatewaySessionGenerationState,
            nextSharedGatewaySessionGeneration,
          );
        }
        return;
      }
    },
    onRestart: async (plan, nextConfig) => {
      const previousRequiredSharedGatewaySessionGeneration =
        params.sharedGatewaySessionGenerationState.required;
      const previousSharedGatewaySessionGeneration =
        params.sharedGatewaySessionGenerationState.current;
      let restartTransaction: GatewayRestartTransactionResult | undefined;
      try {
        const prepared = await params.activateRuntimeSecrets(nextConfig, {
          reason: "restart-check",
          activate: false,
        });
        const nextSharedGatewaySessionGeneration =
          params.resolveSharedGatewaySessionGenerationForConfig(prepared.config);
        restartTransaction = requestGatewayRestart(plan, nextConfig);
        if (restartTransaction.status === "recovery-pending") {
          throw new GatewayHotReloadRecoveryError("config restart");
        }
        if (previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration) {
          params.sharedGatewaySessionGenerationState.required = nextSharedGatewaySessionGeneration;
          disconnectStaleSharedGatewayAuthClients({
            clients: params.clients,
            expectedGeneration: nextSharedGatewaySessionGeneration,
          });
        } else {
          params.sharedGatewaySessionGenerationState.required = null;
        }
        restartTransaction.settle("committed");
      } catch (error) {
        restartTransaction?.settle("rejected");
        params.sharedGatewaySessionGenerationState.required =
          previousRequiredSharedGatewaySessionGeneration;
        throw error;
      }
    },
    log: {
      info: (msg) => params.logReload.info(msg),
      warn: (msg) => params.logReload.warn(msg),
      error: (msg) => params.logReload.error(msg),
    },
    watchPath: params.watchPath,
  });
  return {
    stop: async () => {
      stopped = true;
      stopRestartRetries();
      abortActiveGmailRestart();
      await configReloader.stop();
    },
    hotReloadStatus: configReloader.hotReloadStatus,
  };
}
