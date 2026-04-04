import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/runs.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import type { CliDeps } from "../cli/deps.js";
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { isRestartEnabled } from "../config/commands.js";
import type { loadConfig } from "../config/config.js";
import { startGmailWatcherWithLogs } from "../hooks/gmail-watcher-lifecycle.js";
import { stopGmailWatcher } from "../hooks/gmail-watcher.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import {
  deferGatewayRestartUntilIdle,
  emitGatewayRestart,
  setGatewaySigusr1RestartPolicy,
} from "../infra/restart.js";
import { setCommandLaneConcurrency, getTotalQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { getInspectableTaskRegistrySummary } from "../tasks/task-registry.maintenance.js";
import type { ChannelHealthMonitor } from "./channel-health-monitor.js";
import type { ChannelKind } from "./config-reload-plan.js";
import type { GatewayReloadPlan } from "./config-reload.js";
import { resolveHooksConfig } from "./hooks.js";
import { buildGatewayCronService, type GatewayCronState } from "./server-cron.js";
import type { HookClientIpConfig } from "./server-http.js";
import { resolveHookClientIpConfig } from "./server/hooks.js";

type GatewayHotReloadState = {
  hooksConfig: ReturnType<typeof resolveHooksConfig>;
  hookClientIpConfig: HookClientIpConfig;
  heartbeatRunner: HeartbeatRunner;
  cronState: GatewayCronState;
  channelHealthMonitor: ChannelHealthMonitor | null;
};

export function createGatewayReloadHandlers(params: {
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  getState: () => GatewayHotReloadState;
  setState: (state: GatewayHotReloadState) => void;
  startChannel: (name: ChannelKind) => Promise<void>;
  stopChannel: (name: ChannelKind) => Promise<void>;
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  logCron: { error: (msg: string) => void };
  logReload: { info: (msg: string) => void; warn: (msg: string) => void };
  createHealthMonitor: (opts: {
    checkIntervalMs: number;
    staleEventThresholdMs?: number;
    maxRestartsPerHour?: number;
  }) => ChannelHealthMonitor;
}) {
  const applyHotReload = async (
    plan: GatewayReloadPlan,
    nextConfig: ReturnType<typeof loadConfig>,
  ) => {
    setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
    const state = params.getState();
    const nextState = { ...state };

    if (plan.reloadHooks) {
      try {
        nextState.hooksConfig = resolveHooksConfig(nextConfig);
      } catch (err) {
        params.logHooks.warn(`hooks config reload failed: ${String(err)}`);
      }
    }
    nextState.hookClientIpConfig = resolveHookClientIpConfig(nextConfig);

    if (plan.restartHeartbeat) {
      nextState.heartbeatRunner.updateConfig(nextConfig);
    }

    resetDirectoryCache();

    if (plan.restartCron) {
      state.cronState.cron.stop();
      nextState.cronState = buildGatewayCronService({
        cfg: nextConfig,
        deps: params.deps,
        broadcast: params.broadcast,
      });
      void nextState.cronState.cron
        .start()
        .catch((err) => params.logCron.error(`failed to start: ${String(err)}`));
    }

    if (plan.restartHealthMonitor) {
      state.channelHealthMonitor?.stop();
      const minutes = nextConfig.gateway?.channelHealthCheckMinutes;
      const staleMinutes = nextConfig.gateway?.channelStaleEventThresholdMinutes;
      nextState.channelHealthMonitor =
        minutes === 0
          ? null
          : params.createHealthMonitor({
              checkIntervalMs: (minutes ?? 5) * 60_000,
              ...(staleMinutes != null && { staleEventThresholdMs: staleMinutes * 60_000 }),
              ...(nextConfig.gateway?.channelMaxRestartsPerHour != null && {
                maxRestartsPerHour: nextConfig.gateway.channelMaxRestartsPerHour,
              }),
            });
    }

    if (plan.restartGmailWatcher) {
      await stopGmailWatcher().catch(() => {});
      await startGmailWatcherWithLogs({
        cfg: nextConfig,
        log: params.logHooks,
        onSkipped: () =>
          params.logHooks.info("skipping gmail watcher restart (OPENCLAW_SKIP_GMAIL_WATCHER=1)"),
      });
    }

    if (plan.restartChannels.size > 0) {
      if (
        isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
        isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS)
      ) {
        params.logChannels.info(
          "skipping channel reload (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
        );
      } else {
        const restartChannel = async (name: ChannelKind) => {
          params.logChannels.info(`restarting ${name} channel`);
          await params.stopChannel(name);
          await params.startChannel(name);
        };
        for (const channel of plan.restartChannels) {
          await restartChannel(channel);
        }
      }
    }

    setCommandLaneConcurrency(CommandLane.Cron, nextConfig.cron?.maxConcurrentRuns ?? 1);
    setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(nextConfig));
    setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(nextConfig));

    if (plan.hotReasons.length > 0) {
      params.logReload.info(`config hot reload applied (${plan.hotReasons.join(", ")})`);
    } else if (plan.noopPaths.length > 0) {
      params.logReload.info(`config change applied (dynamic reads: ${plan.noopPaths.join(", ")})`);
    }

    params.setState(nextState);
  };

  let restartPending = false;

  const requestGatewayRestart = (
    plan: GatewayReloadPlan,
    nextConfig: ReturnType<typeof loadConfig>,
  ) => {
    setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
    const reasons = plan.restartReasons.length
      ? plan.restartReasons.join(", ")
      : plan.changedPaths.join(", ");

    if (process.listenerCount("SIGUSR1") === 0) {
      params.logReload.warn("no SIGUSR1 listener found; restart skipped");
      return;
    }

    const getActiveCounts = () => {
      const queueSize = getTotalQueueSize();
      const pendingReplies = getTotalPendingReplies();
      const embeddedRuns = getActiveEmbeddedRunCount();
      const activeTasks = getInspectableTaskRegistrySummary().active;
      return {
        queueSize,
        pendingReplies,
        embeddedRuns,
        activeTasks,
        totalActive: queueSize + pendingReplies + embeddedRuns + activeTasks,
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
      if (counts.activeTasks > 0) {
        details.push(`${counts.activeTasks} task run(s)`);
      }
      return details;
    };
    const active = getActiveCounts();

    if (active.totalActive > 0) {
      // Avoid spinning up duplicate polling loops from repeated config changes.
      if (restartPending) {
        params.logReload.info(
          `config change requires gateway restart (${reasons}) — already waiting for operations to complete`,
        );
        return;
      }
      restartPending = true;
      const initialDetails = formatActiveDetails(active);
      params.logReload.warn(
        `config change requires gateway restart (${reasons}) — deferring until ${initialDetails.join(", ")} complete`,
      );

      deferGatewayRestartUntilIdle({
        getPendingCount: () => getActiveCounts().totalActive,
        maxWaitMs: nextConfig.gateway?.reload?.deferralTimeoutMs,
        hooks: {
          onReady: () => {
            restartPending = false;
            params.logReload.info("all operations and replies completed; restarting gateway now");
          },
          onTimeout: (_pending, elapsedMs) => {
            const remaining = formatActiveDetails(getActiveCounts());
            restartPending = false;
            params.logReload.warn(
              `restart timeout after ${elapsedMs}ms with ${remaining.join(", ")} still active; restarting anyway`,
            );
          },
          onCheckError: (err) => {
            restartPending = false;
            params.logReload.warn(
              `restart deferral check failed (${String(err)}); restarting gateway now`,
            );
          },
        },
      });
    } else {
      // No active operations or pending replies, restart immediately
      params.logReload.warn(`config change requires gateway restart (${reasons})`);
      const emitted = emitGatewayRestart();
      if (!emitted) {
        params.logReload.info("gateway restart already scheduled; skipping duplicate signal");
      }
    }
  };

  return { applyHotReload, requestGatewayRestart };
}
