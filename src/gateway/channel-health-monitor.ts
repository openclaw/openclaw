import type { ChannelId } from "../channels/plugins/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ChannelManager } from "./server-channels.js";

const log = createSubsystemLogger("gateway/health-monitor");

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60_000;
const DEFAULT_STARTUP_GRACE_MS = 60_000;
const DEFAULT_COOLDOWN_CYCLES = 2;
const DEFAULT_MAX_RESTARTS_PER_HOUR = 3;
const ONE_HOUR_MS = 60 * 60_000;

/**
 * How long a connected channel can go without receiving any event before
 * the health monitor treats it as a "stale socket" and triggers a restart.
 * This catches the half-dead WebSocket scenario where the connection appears
 * alive (health checks pass) but Slack silently stops delivering events.
 */
const DEFAULT_STALE_EVENT_THRESHOLD_MS = 30 * 60_000;

export type ChannelHealthMonitorDeps = {
  channelManager: ChannelManager;
  checkIntervalMs?: number;
  startupGraceMs?: number;
  cooldownCycles?: number;
  maxRestartsPerHour?: number;
  staleEventThresholdMs?: number;
  abortSignal?: AbortSignal;
};

export type ChannelHealthMonitor = {
  stop: () => void;
};

type RestartRecord = {
  lastRestartAt: number;
  restartsThisHour: { at: number }[];
};

function isManagedAccount(snapshot: { enabled?: boolean; configured?: boolean }): boolean {
  return snapshot.enabled !== false && snapshot.configured !== false;
}

function isChannelHealthy(
  snapshot: {
    running?: boolean;
    connected?: boolean;
    enabled?: boolean;
    configured?: boolean;
    lastEventAt?: number | null;
    lastStartAt?: number | null;
  },
  opts: { now: number; staleEventThresholdMs: number },
): boolean {
  if (!isManagedAccount(snapshot)) {
    return true;
  }
  if (!snapshot.running) {
    return false;
  }
  if (snapshot.connected === false) {
    return false;
  }

  // Stale socket detection: if the channel has been running long enough
  // (past the stale threshold) and we have never received an event, or the
  // last event was received longer ago than the threshold, treat as unhealthy.
  if (snapshot.lastEventAt != null || snapshot.lastStartAt != null) {
    const upSince = snapshot.lastStartAt ?? 0;
    const upDuration = opts.now - upSince;
    if (upDuration > opts.staleEventThresholdMs) {
      const lastEvent = snapshot.lastEventAt ?? 0;
      const eventAge = opts.now - lastEvent;
      if (eventAge > opts.staleEventThresholdMs) {
        return false;
      }
    }
  }

  return true;
}

export function startChannelHealthMonitor(deps: ChannelHealthMonitorDeps): ChannelHealthMonitor {
  const {
    channelManager,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    startupGraceMs = DEFAULT_STARTUP_GRACE_MS,
    cooldownCycles = DEFAULT_COOLDOWN_CYCLES,
    maxRestartsPerHour = DEFAULT_MAX_RESTARTS_PER_HOUR,
    staleEventThresholdMs = DEFAULT_STALE_EVENT_THRESHOLD_MS,
    abortSignal,
  } = deps;

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
      if (now - startedAt < startupGraceMs) {
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
          if (!isManagedAccount(status)) {
            continue;
          }
          if (channelManager.isManuallyStopped(channelId as ChannelId, accountId)) {
            continue;
          }
          if (isChannelHealthy(status, { now, staleEventThresholdMs })) {
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

          const isStaleSocket =
            status.running &&
            status.connected !== false &&
            status.lastEventAt != null &&
            now - (status.lastEventAt ?? 0) > staleEventThresholdMs;

          const reason = !status.running
            ? status.reconnectAttempts && status.reconnectAttempts >= 10
              ? "gave-up"
              : "stopped"
            : isStaleSocket
              ? "stale-socket"
              : "stuck";

          log.info?.(`[${channelId}:${accountId}] health-monitor: restarting (reason: ${reason})`);

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
      `started (interval: ${Math.round(checkIntervalMs / 1000)}s, grace: ${Math.round(startupGraceMs / 1000)}s)`,
    );
  }

  return { stop };
}
