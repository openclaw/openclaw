import type { ChannelId } from "../channels/plugins/types.js";
import type { ChannelHealthRestartMode } from "../config/types.channels.js";
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
  /**
   * Default restart mode for unhealthy channels.
   *
   * `"stop-start"` (default): full stop → start cycle.
   * `"reconnect"`: lightweight stop → start that skips resetting the restart
   *   counter, signalling to the channel runtime that this is a soft reconnect
   *   rather than a hard restart. Falls back to `"stop-start"` on error.
   *
   * The per-channel `healthMonitor.restartMode` config overrides this value.
   */
  defaultRestartMode?: ChannelHealthRestartMode;
  abortSignal?: AbortSignal;
};

export type ChannelHealthMonitor = {
  stop: () => void;
};

type RestartRecord = {
  lastRestartAt: number;
  restartsThisHour: { at: number }[];
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
    defaultRestartMode = "stop-start",
    abortSignal,
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
          if (health.healthy) {
            continue;
          }

          const key = rKey(channelId, accountId);
          const record = restartRecords.get(key) ?? {
            lastRestartAt: 0,
            restartsThisHour: [],
          };

          if (now - record.lastRestartAt <= cooldownMs) {
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

          // Resolve effective restart mode: per-channel config overrides the global default.
          const channelCfg = channelManager.getChannelHealthMonitorConfig?.(
            channelId as ChannelId,
            accountId,
          );
          const effectiveRestartMode: ChannelHealthRestartMode =
            channelCfg?.restartMode ?? defaultRestartMode;

          log.info?.(
            `[${channelId}:${accountId}] health-monitor: restarting (reason: ${reason}, mode: ${effectiveRestartMode})`,
          );

          try {
            if (effectiveRestartMode === "reconnect") {
              // Lightweight reconnect: stop → start without resetting the
              // restart-attempt counter. Preserves SDK session state where
              // the provider supports resumption (e.g. Discord RESUME), which
              // avoids invalidating Anthropic prompt-cache context.
              if (status.running) {
                await channelManager.stopChannel(channelId as ChannelId, accountId);
              }
              await channelManager.startChannel(channelId as ChannelId, accountId);
            } else {
              // Default stop-start: full cycle with counter reset.
              if (status.running) {
                await channelManager.stopChannel(channelId as ChannelId, accountId);
              }
              channelManager.resetRestartAttempts(channelId as ChannelId, accountId);
              await channelManager.startChannel(channelId as ChannelId, accountId);
            }
            record.lastRestartAt = now;
            record.restartsThisHour.push({ at: now });
            restartRecords.set(key, record);
          } catch (err) {
            log.error?.(
              `[${channelId}:${accountId}] health-monitor: restart failed: ${String(err)}`,
            );
            // If reconnect mode failed, fall back to stop-start on next cycle.
            if (effectiveRestartMode === "reconnect") {
              log.warn?.(
                `[${channelId}:${accountId}] health-monitor: reconnect failed, will retry with stop-start`,
              );
            }
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
