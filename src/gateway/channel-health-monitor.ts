import type { ChannelId } from "../channels/plugins/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
  resolveChannelRestartReason,
  type ChannelHealthPolicy,
} from "./channel-health-policy.js";
import type { ChannelManager } from "./server-channels.js";

const log = createSubsystemLogger("gateway/health-monitor");

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MONITOR_STARTUP_GRACE_MS = 60_000;
const DEFAULT_COOLDOWN_CYCLES = 2;
const DEFAULT_MAX_RESTARTS_PER_HOUR = 10;
const ONE_HOUR_MS = 60 * 60_000;

/**
 * How long a connected channel can go without receiving any event before
 * the health monitor treats it as a "stale socket" and triggers a restart.
 * This catches the half-dead WebSocket scenario where the connection appears
 * alive (health checks pass) but Slack silently stops delivering events.
 */
export type ChannelHealthTimingPolicy = {
  monitorStartupGraceMs: number;
  channelConnectGraceMs: number;
  staleEventThresholdMs: number;
};

export type ChannelHealthMonitorDeps = {
  channelManager: ChannelManager;
  checkIntervalMs?: number;
  /** @deprecated use timing.monitorStartupGraceMs */
  startupGraceMs?: number;
  /** @deprecated use timing.channelConnectGraceMs */
  channelStartupGraceMs?: number;
  /** @deprecated use timing.staleEventThresholdMs */
  staleEventThresholdMs?: number;
  timing?: Partial<ChannelHealthTimingPolicy>;
  cooldownCycles?: number;
  maxRestartsPerHour?: number;
  abortSignal?: AbortSignal;
  /**
   * Called before restarting a channel that has failed multiple consecutive
   * health-monitor restarts without becoming stable.  The callback receives
   * the channel/account identifiers and the number of consecutive restarts
   * so far, allowing channel-specific escalation (e.g. clearing Discord
   * resume state to force a fresh IDENTIFY).
   */
  onBeforeRestart?: (params: {
    channelId: ChannelId;
    accountId: string;
    consecutiveRestarts: number;
  }) => void;
  /** Called when a previously-restarted channel has been healthy long enough
   *  to be considered stable.  Useful for resetting channel-specific persistent
   *  state (e.g. Discord hello-stall counters). */
  onChannelStable?: (params: { channelId: ChannelId; accountId: string }) => void;
};

export type ChannelHealthMonitor = {
  stop: () => void;
};

/** How long a channel must stay healthy after a restart before we consider it stable. */
const STABLE_THRESHOLD_MS = 5 * 60_000;
/** After this many consecutive restarts without stability, escalate (e.g. fresh IDENTIFY). */
const ESCALATION_THRESHOLD = 3;
/** Max backoff multiplier exponent for exponential cooldown. */
const MAX_BACKOFF_EXPONENT = 3;
/** Hard cap on exponential cooldown (60 minutes). */
const MAX_COOLDOWN_MS = 60 * 60_000;

type RestartRecord = {
  lastRestartAt: number;
  restartsThisHour: { at: number }[];
  /** Number of health-monitor restarts without the channel becoming stable. */
  consecutiveRestarts: number;
  /** Timestamp of the first healthy check after a restart.  Tracks continuous
   *  uptime so a brief healthy→unhealthy flap does not satisfy the stability
   *  window and prematurely reset consecutiveRestarts. */
  healthySince?: number;
};

function resolveTimingPolicy(
  deps: Pick<
    ChannelHealthMonitorDeps,
    "startupGraceMs" | "channelStartupGraceMs" | "staleEventThresholdMs" | "timing"
  >,
): ChannelHealthTimingPolicy {
  return {
    monitorStartupGraceMs:
      deps.timing?.monitorStartupGraceMs ?? deps.startupGraceMs ?? DEFAULT_MONITOR_STARTUP_GRACE_MS,
    channelConnectGraceMs:
      deps.timing?.channelConnectGraceMs ??
      deps.channelStartupGraceMs ??
      DEFAULT_CHANNEL_CONNECT_GRACE_MS,
    staleEventThresholdMs:
      deps.timing?.staleEventThresholdMs ??
      deps.staleEventThresholdMs ??
      DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  };
}

export function startChannelHealthMonitor(deps: ChannelHealthMonitorDeps): ChannelHealthMonitor {
  const {
    channelManager,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    cooldownCycles = DEFAULT_COOLDOWN_CYCLES,
    maxRestartsPerHour = DEFAULT_MAX_RESTARTS_PER_HOUR,
    abortSignal,
    onBeforeRestart,
    onChannelStable,
  } = deps;
  const timing = resolveTimingPolicy(deps);

  const cooldownMs = cooldownCycles * checkIntervalMs;
  const restartRecords = new Map<string, RestartRecord>();
  const startedAt = Date.now();
  let stopped = false;
  let checkInFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const rKey = (channelId: string, accountId: string) => `${channelId}:${accountId}`;

  function pruneOldRestarts(record: RestartRecord, now: number) {
    record.restartsThisHour = record.restartsThisHour.filter((r) => now - r.at < ONE_HOUR_MS);
  }

  async function runCheck() {
    if (stopped || checkInFlight) {
      return;
    }
    checkInFlight = true;

    try {
      const now = Date.now();
      if (now - startedAt < timing.monitorStartupGraceMs) {
        return;
      }

      const snapshot = channelManager.getRuntimeSnapshot();

      for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
        if (!accounts) {
          continue;
        }
        for (const [accountId, status] of Object.entries(accounts)) {
          if (!status) {
            continue;
          }
          if (!channelManager.isHealthMonitorEnabled(channelId as ChannelId, accountId)) {
            continue;
          }
          if (channelManager.isManuallyStopped(channelId as ChannelId, accountId)) {
            continue;
          }
          const healthPolicy: ChannelHealthPolicy = {
            channelId,
            now,
            staleEventThresholdMs: timing.staleEventThresholdMs,
            channelConnectGraceMs: timing.channelConnectGraceMs,
          };
          const health = evaluateChannelHealth(status, healthPolicy);

          const key = rKey(channelId, accountId);
          const record = restartRecords.get(key) ?? {
            lastRestartAt: 0,
            restartsThisHour: [],
            consecutiveRestarts: 0,
          };

          // Stability check: if the channel is healthy and has been continuously
          // healthy for STABLE_THRESHOLD_MS, reset the consecutive counter.
          // We track healthySince (set on first healthy check after a restart)
          // so a brief healthy→unhealthy flap does not satisfy the window.
          if (health.healthy) {
            if (record.consecutiveRestarts > 0 && !record.healthySince) {
              // First healthy check after a restart — start the stability clock.
              record.healthySince = now;
              restartRecords.set(key, record);
            }
            if (
              record.consecutiveRestarts > 0 &&
              record.healthySince &&
              now - record.healthySince >= STABLE_THRESHOLD_MS
            ) {
              log.info?.(
                `[${channelId}:${accountId}] health-monitor: channel stable after ${record.consecutiveRestarts} restart(s), resetting counter`,
              );
              record.consecutiveRestarts = 0;
              record.healthySince = undefined;
              restartRecords.set(key, record);
              onChannelStable?.({ channelId: channelId as ChannelId, accountId });
            }
            continue;
          }

          // Channel is unhealthy — clear the healthy-window timestamp so a
          // prior brief health run does not carry forward into the next
          // stability measurement.
          if (record.healthySince !== undefined) {
            record.healthySince = undefined;
            restartRecords.set(key, record);
          }

          // Apply exponential backoff: base cooldown × 2^min(consecutiveRestarts, cap)
          const backoffExponent = Math.min(record.consecutiveRestarts, MAX_BACKOFF_EXPONENT);
          const effectiveCooldownMs = Math.min(cooldownMs * 2 ** backoffExponent, MAX_COOLDOWN_MS);

          if (now - record.lastRestartAt <= effectiveCooldownMs) {
            continue;
          }

          pruneOldRestarts(record, now);
          if (record.restartsThisHour.length >= maxRestartsPerHour) {
            log.warn?.(
              `[${channelId}:${accountId}] health-monitor: hit ${maxRestartsPerHour} restarts/hour limit, skipping`,
            );
            continue;
          }

          const reason = resolveChannelRestartReason(status, health);
          const nextConsecutive = record.consecutiveRestarts + 1;

          log.info?.(
            `[${channelId}:${accountId}] health-monitor: restarting (reason: ${reason}, consecutive: ${nextConsecutive})`,
          );

          // Optimistically increment consecutiveRestarts before the restart
          // attempt so that if the restart fails, backoff still increases on
          // the next cycle and the escalation callback does not re-fire at
          // the same threshold level.
          record.consecutiveRestarts = nextConsecutive;
          restartRecords.set(key, record);

          // Escalation: after N consecutive restarts without stability, notify
          // the caller so it can take channel-specific recovery action (e.g.
          // clearing Discord resume state to force a fresh IDENTIFY).
          if (nextConsecutive >= ESCALATION_THRESHOLD && onBeforeRestart) {
            onBeforeRestart({
              channelId: channelId as ChannelId,
              accountId,
              consecutiveRestarts: nextConsecutive,
            });
          }

          try {
            if (status.running) {
              await channelManager.stopChannel(channelId as ChannelId, accountId);
            }
            channelManager.resetRestartAttempts(channelId as ChannelId, accountId);
            await channelManager.startChannel(channelId as ChannelId, accountId);
            record.lastRestartAt = now;
            record.restartsThisHour.push({ at: now });
            restartRecords.set(key, record);
          } catch (err) {
            log.error?.(
              `[${channelId}:${accountId}] health-monitor: restart failed: ${String(err)}`,
            );
            // Record the attempt time even on failure so the exponential
            // cooldown is respected on the next check cycle; without this,
            // lastRestartAt stays at its previous value and the cooldown
            // guard is bypassed, causing rapid retries on persistent failures.
            record.lastRestartAt = now;
            restartRecords.set(key, record);
          }
        }
      }
    } finally {
      checkInFlight = false;
    }
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  if (abortSignal?.aborted) {
    stopped = true;
  } else {
    abortSignal?.addEventListener("abort", stop, { once: true });
    timer = setInterval(() => void runCheck(), checkIntervalMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
    log.info?.(
      `started (interval: ${Math.round(checkIntervalMs / 1000)}s, startup-grace: ${Math.round(timing.monitorStartupGraceMs / 1000)}s, channel-connect-grace: ${Math.round(timing.channelConnectGraceMs / 1000)}s)`,
    );
  }

  return { stop };
}
