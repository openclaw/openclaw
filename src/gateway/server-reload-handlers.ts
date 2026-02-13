import type { CliDeps } from "../cli/deps.js";
import type { loadConfig } from "../config/config.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import type { ChannelKind, GatewayReloadPlan } from "./config-reload.js";
import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/runs.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { startGmailWatcher, stopGmailWatcher } from "../hooks/gmail-watcher.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import { emitGatewayRestart, setGatewaySigusr1RestartPolicy } from "../infra/restart.js";
import { setCommandLaneConcurrency, getTotalQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { resolveHooksConfig } from "./hooks.js";
import { startBrowserControlServerIfEnabled } from "./server-browser.js";
import { buildGatewayCronService, type GatewayCronState } from "./server-cron.js";

type GatewayHotReloadState = {
  hooksConfig: ReturnType<typeof resolveHooksConfig>;
  heartbeatRunner: HeartbeatRunner;
  cronState: GatewayCronState;
  browserControl: Awaited<ReturnType<typeof startBrowserControlServerIfEnabled>> | null;
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
  logBrowser: { error: (msg: string) => void };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  logCron: { error: (msg: string) => void };
  logReload: { info: (msg: string) => void; warn: (msg: string) => void };
}) {
  const applyHotReload = async (
    plan: GatewayReloadPlan,
    nextConfig: ReturnType<typeof loadConfig>,
  ) => {
    setGatewaySigusr1RestartPolicy({ allowExternal: nextConfig.commands?.restart === true });
    const state = params.getState();
    const nextState = { ...state };

    if (plan.reloadHooks) {
      try {
        nextState.hooksConfig = resolveHooksConfig(nextConfig);
      } catch (err) {
        params.logHooks.warn(`hooks config reload failed: ${String(err)}`);
      }
    }

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

    if (plan.restartBrowserControl) {
      if (state.browserControl) {
        await state.browserControl.stop().catch(() => {});
      }
      try {
        nextState.browserControl = await startBrowserControlServerIfEnabled();
      } catch (err) {
        params.logBrowser.error(`server failed to start: ${String(err)}`);
      }
    }

    if (plan.restartGmailWatcher) {
      await stopGmailWatcher().catch(() => {});
      if (!isTruthyEnvValue(process.env.OPENCLAW_SKIP_GMAIL_WATCHER)) {
        try {
          const gmailResult = await startGmailWatcher(nextConfig);
          if (gmailResult.started) {
            params.logHooks.info("gmail watcher started");
          } else if (
            gmailResult.reason &&
            gmailResult.reason !== "hooks not enabled" &&
            gmailResult.reason !== "no gmail account configured"
          ) {
            params.logHooks.warn(`gmail watcher not started: ${gmailResult.reason}`);
          }
        } catch (err) {
          params.logHooks.error(`gmail watcher failed to start: ${String(err)}`);
        }
      } else {
        params.logHooks.info("skipping gmail watcher restart (OPENCLAW_SKIP_GMAIL_WATCHER=1)");
      }
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
    setGatewaySigusr1RestartPolicy({ allowExternal: nextConfig.commands?.restart === true });
    const reasons = plan.restartReasons.length
      ? plan.restartReasons.join(", ")
      : plan.changedPaths.join(", ");

    if (process.listenerCount("SIGUSR1") === 0) {
      params.logReload.warn("no SIGUSR1 listener found; restart skipped");
      return;
    }

    // Check if there are active operations (commands in queue, pending replies, or embedded runs)
    const queueSize = getTotalQueueSize();
    const pendingReplies = getTotalPendingReplies();
    const embeddedRuns = getActiveEmbeddedRunCount();
    const totalActive = queueSize + pendingReplies + embeddedRuns;

    if (totalActive > 0) {
      // Avoid spinning up duplicate polling loops from repeated config changes.
      if (restartPending) {
        params.logReload.info(
          `config change requires gateway restart (${reasons}) — already waiting for operations to complete`,
        );
        return;
      }
      restartPending = true;
      const details = [];
      if (queueSize > 0) {
        details.push(`${queueSize} queued operation(s)`);
      }
      if (pendingReplies > 0) {
        details.push(`${pendingReplies} pending reply(ies)`);
      }
      if (embeddedRuns > 0) {
        details.push(`${embeddedRuns} embedded run(s)`);
      }
      params.logReload.warn(
        `config change requires gateway restart (${reasons}) — deferring until ${details.join(", ")} complete`,
      );

      // Wait for all operations and replies to complete before restarting (max 30 seconds)
      const maxWaitMs = 30_000;
      const checkIntervalMs = 500;
      const startTime = Date.now();

      const checkAndRestart = () => {
        const currentQueueSize = getTotalQueueSize();
        const currentPendingReplies = getTotalPendingReplies();
        const currentEmbeddedRuns = getActiveEmbeddedRunCount();
        const currentTotalActive = currentQueueSize + currentPendingReplies + currentEmbeddedRuns;
        const elapsed = Date.now() - startTime;

        if (currentTotalActive === 0) {
          restartPending = false;
          params.logReload.info("all operations and replies completed; restarting gateway now");
          emitGatewayRestart();
        } else if (elapsed >= maxWaitMs) {
          const remainingDetails = [];
          if (currentQueueSize > 0) {
            remainingDetails.push(`${currentQueueSize} operation(s)`);
          }
          if (currentPendingReplies > 0) {
            remainingDetails.push(`${currentPendingReplies} reply(ies)`);
          }
          if (currentEmbeddedRuns > 0) {
            remainingDetails.push(`${currentEmbeddedRuns} embedded run(s)`);
          }
          restartPending = false;
          params.logReload.warn(
            `restart timeout after ${elapsed}ms with ${remainingDetails.join(", ")} still active; restarting anyway`,
          );
          emitGatewayRestart();
        } else {
          // Check again soon
          setTimeout(checkAndRestart, checkIntervalMs);
        }
      };

      setTimeout(checkAndRestart, checkIntervalMs);
    } else {
      // No active operations or pending replies, restart immediately
      params.logReload.warn(`config change requires gateway restart (${reasons})`);
      emitGatewayRestart();
    }
  };

  return { applyHotReload, requestGatewayRestart };
}
