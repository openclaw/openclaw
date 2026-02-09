import type { CliDeps } from "../cli/deps.js";
import type { loadConfig } from "../config/config.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import type { ChannelKind, GatewayReloadPlan } from "./config-reload.js";
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { startGmailWatcher, stopGmailWatcher } from "../hooks/gmail-watcher.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import {
  authorizeGatewaySigusr1Restart,
  setGatewaySigusr1RestartPolicy,
} from "../infra/restart.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { resolveHooksConfig, resolveWebhooksConfig } from "./hooks.js";
import { startBrowserControlServerIfEnabled } from "./server-browser.js";
import { buildGatewayCronService, type GatewayCronState } from "./server-cron.js";

type GatewayHotReloadState = {
  hooksConfig: ReturnType<typeof resolveHooksConfig>;
  webhooksConfig: ReturnType<typeof resolveWebhooksConfig>;
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
        nextState.webhooksConfig = resolveWebhooksConfig(nextConfig);
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

  const requestGatewayRestart = (
    plan: GatewayReloadPlan,
    nextConfig: ReturnType<typeof loadConfig>,
  ) => {
    setGatewaySigusr1RestartPolicy({ allowExternal: nextConfig.commands?.restart === true });
    const reasons = plan.restartReasons.length
      ? plan.restartReasons.join(", ")
      : plan.changedPaths.join(", ");
    params.logReload.warn(`config change requires gateway restart (${reasons})`);
    if (process.listenerCount("SIGUSR1") === 0) {
      params.logReload.warn("no SIGUSR1 listener found; restart skipped");
      return;
    }
    authorizeGatewaySigusr1Restart();
    process.emit("SIGUSR1");
  };

  return { applyHotReload, requestGatewayRestart };
}
