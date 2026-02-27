import type { ChannelId } from "../channels/plugins/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ChannelManager } from "./server-channels.js";

const log = createSubsystemLogger("gateway/health-monitor");

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60_000;
const DEFAULT_STARTUP_GRACE_MS = 60_000;
const DEFAULT_COOLDOWN_CYCLES = 2;
const DEFAULT_MAX_RESTARTS_PER_HOUR = 3;
const DEFAULT_STALE_INBOUND_THRESHOLD_MS = 15 * 60_000; // 15 minutes
const ONE_HOUR_MS = 60 * 60_000;

export type ChannelHealthMonitorDeps = {
  channelManager: ChannelManager;
  checkIntervalMs?: number;
  startupGraceMs?: number;
  cooldownCycles?: number;
  maxRestartsPerHour?: number;
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
    lastInboundAt?: number | null;
  },
  staleThresholdMs: number = DEFAULT_STALE_INBOUND_THRESHOLD_MS,
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

  // Detect zombie polling: running but no inbound for too long
  if (snapshot.lastInboundAt != null) {
    const stalenessMs = Date.now() - snapshot.lastInboundAt;
    if (stalenessMs > staleThresholdMs) {
      return false; // trigger restart
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
          if (isChannelHealthy(status)) {
            continue;
          }

          // Log stale detection for observability
          if (
            status.lastInboundAt != null &&
            Date.now() - status.lastInboundAt > DEFAULT_STALE_INBOUND_THRESHOLD_MS
          ) {
            const stalenessMin = Math.round((Date.now() - status.lastInboundAt) / 60_000);
            log.warn?.(
              `[${channelId}:${accountId}] health-monitor: detected stale channel (no inbound for ${stalenessMin}min)`,
            );
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

          const reason = !status.running
            ? status.reconnectAttempts && status.reconnectAttempts >= 10
              ? "gave-up"
              : "stopped"
            : status.connected === false
              ? "disconnected"
              : status.lastInboundAt != null &&
                  Date.now() - status.lastInboundAt > DEFAULT_STALE_INBOUND_THRESHOLD_MS
                ? "stale"
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
