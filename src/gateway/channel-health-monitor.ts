import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { settlesWithin } from "../shared/settle-within.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
  resolveChannelRestartReason,
} from "./channel-health-policy.js";
import type { ChannelManager } from "./server-channels.js";

const log = createSubsystemLogger("gateway/health-monitor");

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MONITOR_STARTUP_GRACE_MS = 60_000;
const DEFAULT_COOLDOWN_CYCLES = 2;
const CHANNEL_HEALTH_MONITOR_HANDOFF_TIMEOUT_MS = 5_000;

export type ChannelHealthMonitor = {
  stop: () => void;
  shutdown: () => void;
  waitForIdle: () => Promise<void>;
};

export function startChannelHealthMonitor(params: {
  channelManager: ChannelManager;
  scheduler: GatewayScheduler;
}): ChannelHealthMonitor {
  const { channelManager } = params;
  const scheduler = params.scheduler.scope();
  const cooldownMs = DEFAULT_COOLDOWN_CYCLES * DEFAULT_CHECK_INTERVAL_MS;
  const lastRestartTimes = new Map<string, number>();
  const startedAt = scheduler.now();
  let stopped = false;
  let abandonInFlightRestart = false;
  let activeCheck: Promise<void> | null = null;
  const suppressedAccounts = new Set<string>();

  async function runCheckWork() {
    try {
      const now = scheduler.now();
      if (now - startedAt < DEFAULT_MONITOR_STARTUP_GRACE_MS) {
        return;
      }

      if (channelManager.getAutostartSuppression() !== null) {
        await channelManager.recoverAutostartSuppression(scheduler.signal);
      }
      const snapshot = channelManager.getRuntimeSnapshot();
      const globalAutostartSuppression = channelManager.getAutostartSuppression();

      for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
        if (!accounts || snapshot.reloadingChannels?.has(channelId)) {
          continue;
        }
        const autostartSuppressed =
          globalAutostartSuppression !== null ||
          channelManager.isAmbientAutostartSuppressed(channelId);
        for (const [accountId, status] of Object.entries(accounts)) {
          // A replacement monitor owns future accounts. The retired monitor may
          // only finish the restart it had already begun.
          if (stopped) {
            return;
          }
          if (!status) {
            continue;
          }
          // Status also exposes unlisted lifetimes; automatic recovery keeps its configured scope.
          if (!channelManager.isAccountListed(channelId, accountId)) {
            continue;
          }
          if (!channelManager.isHealthMonitorEnabled(channelId, accountId)) {
            continue;
          }
          if (channelManager.isManuallyStopped(channelId, accountId)) {
            continue;
          }
          const key = `${channelId}:${accountId}`;
          if (autostartSuppressed) {
            if (status.running !== true && !suppressedAccounts.has(key)) {
              log.info(
                `[${channelId}:${accountId}] health-monitor: channel autostart suppressed; treating as expected stopped`,
              );
              suppressedAccounts.add(key);
            }
            continue;
          }
          suppressedAccounts.delete(key);
          const health = evaluateChannelHealth(status, {
            channelId,
            now,
            staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
            channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
          });
          if (health.healthy) {
            continue;
          }
          if (health.reason === "terminal-disconnect" || health.reason === "blocked") {
            log.info(
              `[${channelId}:${accountId}] health-monitor: skipping restart, ${health.reason}`,
            );
            continue;
          }
          // The channel supervisor owns the account while its own backoff restart
          // is in flight. Restarting here cannot start anything (the supervisor
          // still holds the account task) and only resets the attempt ladder, so
          // a crash-looping channel would never reach its give-up terminal state.
          if (channelManager.isAutoRestartScheduled(channelId, accountId)) {
            continue;
          }

          if (now - (lastRestartTimes.get(key) ?? 0) <= cooldownMs) {
            continue;
          }

          const reason = resolveChannelRestartReason(status, health);

          log.info(`[${channelId}:${accountId}] health-monitor: restarting (reason: ${reason})`);

          lastRestartTimes.set(key, now);

          try {
            if (status.running) {
              await channelManager.stopChannel(channelId, accountId, {
                manual: false,
              });
            }
            // Shutdown owns channel teardown, so a stop that completes after the
            // shutdown handoff must not resurrect the channel.
            if (abandonInFlightRestart) {
              return;
            }
            if (!channelManager.isAccountListed(channelId, accountId)) {
              continue;
            }
            channelManager.resetRestartAttempts(channelId, accountId);
            await channelManager.startChannel(channelId, accountId, { reason: "health-monitor" });
          } catch (err) {
            log.error(`[${channelId}:${accountId}] health-monitor: restart failed: ${String(err)}`);
          }
        }
      }
    } catch (err) {
      if (!scheduler.signal.aborted) {
        log.error(`health-monitor: check failed: ${String(err)}`);
      }
    }
  }

  function runCheck(): Promise<void> {
    activeCheck = runCheckWork().finally(() => {
      activeCheck = null;
    });
    return activeCheck;
  }

  function retire(abandonRestart: boolean) {
    stopped = true;
    abandonInFlightRestart ||= abandonRestart;
    scheduler.beginClose();
  }

  const stop = () => retire(false);
  const shutdown = () => retire(true);
  const waitForIdle = async () => {
    const check = activeCheck;
    if (!check) {
      return;
    }
    if (!(await settlesWithin(check, CHANNEL_HEALTH_MONITOR_HANDOFF_TIMEOUT_MS))) {
      // A late provider stop must not block lifecycle ownership or restart after
      // the replacement/shutdown handoff has already continued.
      shutdown();
      log.warn(
        `health-monitor handoff exceeded ${CHANNEL_HEALTH_MONITOR_HANDOFF_TIMEOUT_MS}ms; abandoning delayed restart`,
      );
    }
  };

  scheduler.schedule({
    id: "channel-health-monitor",
    atMs: startedAt + DEFAULT_MONITOR_STARTUP_GRACE_MS,
    everyMs: DEFAULT_CHECK_INTERVAL_MS,
    run: runCheck,
  });
  log.info(
    `started (interval: ${Math.round(DEFAULT_CHECK_INTERVAL_MS / 1000)}s, startup-grace: ${Math.round(DEFAULT_MONITOR_STARTUP_GRACE_MS / 1000)}s, channel-connect-grace: ${Math.round(DEFAULT_CHANNEL_CONNECT_GRACE_MS / 1000)}s)`,
  );

  return { stop, shutdown, waitForIdle };
}
