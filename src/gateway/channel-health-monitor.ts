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

/** Minimum cooldown between health-monitor-triggered restarts per channel. */
const MIN_RESTART_COOLDOWN_MS = 60_000;

/** Maximum time to wait for active agent runs to drain before aborting. */
const DRAIN_WINDOW_MS = 30_000;
const DRAIN_POLL_MS = 1_000;

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
  /** Called each check cycle to resolve fresh timing values (avoids stale config). */
  resolveFreshTiming?: () => Partial<ChannelHealthTimingPolicy>;
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

/** How long before run activity is considered stale / not belonging to any live run. */
const STALE_RUN_ACTIVITY_MS = 25 * 60_000;

/**
 * Wait up to {@link DRAIN_WINDOW_MS} for active agent runs on a channel/account
 * to finish so in-flight text replies are not silently aborted.
 *
 * Returns immediately (without waiting) when the busy state is determined to be
 * stale — i.e. inherited from a prior lifecycle with no real in-flight runs.
 */
async function drainActiveRuns(
  channelManager: ChannelManager,
  channelId: ChannelId,
  accountId: string,
  isStopped: () => boolean,
): Promise<void> {
  const deadline = Date.now() + DRAIN_WINDOW_MS;
  let warned = false;
  let checkedStaleness = false;
  while (!isStopped() && Date.now() < deadline) {
    const snap = channelManager.getRuntimeSnapshot();
    const accountSnap = snap.channelAccounts[channelId]?.[accountId];
    const activeRuns =
      typeof accountSnap?.activeRuns === "number" && Number.isFinite(accountSnap.activeRuns)
        ? Math.max(0, Math.trunc(accountSnap.activeRuns))
        : 0;
    if (activeRuns === 0) {
      return;
    }
    // On the first iteration with active runs, check whether the busy state is stale
    // (e.g. inherited from a prior lifecycle). If so, there are no real in-flight runs
    // to protect — return immediately to avoid burning the full drain window.
    if (!checkedStaleness) {
      checkedStaleness = true;
      const lastStartAt =
        typeof accountSnap?.lastStartAt === "number" && Number.isFinite(accountSnap.lastStartAt)
          ? accountSnap.lastStartAt
          : null;
      const lastRunActivityAt =
        typeof accountSnap?.lastRunActivityAt === "number" &&
        Number.isFinite(accountSnap.lastRunActivityAt)
          ? accountSnap.lastRunActivityAt
          : null;
      const isStale =
        lastRunActivityAt == null ||
        (lastStartAt != null && lastRunActivityAt < lastStartAt) ||
        Date.now() - lastRunActivityAt > STALE_RUN_ACTIVITY_MS;
      if (isStale) {
        log.info?.(
          `[${channelId}:${accountId}] health-monitor: skipping drain — busy state is stale (inherited from prior lifecycle)`,
        );
        return;
      }
    }
    if (!warned) {
      log.info?.(
        `[${channelId}:${accountId}] health-monitor: waiting for ${activeRuns} active run(s) to drain`,
      );
      warned = true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
  }
}

export function startChannelHealthMonitor(deps: ChannelHealthMonitorDeps): ChannelHealthMonitor {
  const {
    channelManager,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    cooldownCycles = DEFAULT_COOLDOWN_CYCLES,
    maxRestartsPerHour = DEFAULT_MAX_RESTARTS_PER_HOUR,
    abortSignal,
  } = deps;
  const timing = resolveTimingPolicy(deps);

  const cooldownMs = Math.max(cooldownCycles * checkIntervalMs, MIN_RESTART_COOLDOWN_MS);
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

      // Re-resolve timing each cycle so runtime config changes are picked up
      // without waiting for a full health-monitor restart.
      const freshTiming = deps.resolveFreshTiming?.();
      const effectiveTiming: ChannelHealthTimingPolicy = freshTiming
        ? { ...timing, ...freshTiming }
        : timing;

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
            staleEventThresholdMs: effectiveTiming.staleEventThresholdMs,
            channelConnectGraceMs: effectiveTiming.channelConnectGraceMs,
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

          log.info?.(`[${channelId}:${accountId}] health-monitor: restarting (reason: ${reason})`);

          try {
            if (status.running) {
              await drainActiveRuns(
                channelManager,
                channelId as ChannelId,
                accountId,
                () => stopped,
              );
              // If the monitor was stopped during the drain window, abort the restart.
              if (stopped) {
                return;
              }
              // Re-evaluate channel health after drain: the channel may have recovered
              // or reconnected while we were waiting. Only proceed if still unhealthy.
              const postDrainSnap = channelManager.getRuntimeSnapshot();
              const postDrainStatus = postDrainSnap.channelAccounts[channelId]?.[accountId];
              // Account was removed during drain (config hot-reload) — do not resurrect it.
              if (!postDrainStatus) {
                log.debug?.(
                  `[${channelId}:${accountId}] health-monitor: account removed during drain, skipping restart`,
                );
                continue;
              }
              if (postDrainStatus) {
                const postDrainHealth = evaluateChannelHealth(postDrainStatus, {
                  ...healthPolicy,
                  now: Date.now(),
                });
                if (postDrainHealth.healthy) {
                  log.info?.(
                    `[${channelId}:${accountId}] health-monitor: channel recovered during drain, skipping restart`,
                  );
                  continue;
                }
              }
              // Re-check monitor enablement after drain — operator may have disabled it.
              if (!channelManager.isHealthMonitorEnabled(channelId as ChannelId, accountId)) {
                log.info?.(
                  `[${channelId}:${accountId}] health-monitor: monitor disabled during drain, skipping restart`,
                );
                continue;
              }
              // Re-prune the hourly bucket with a fresh timestamp so that entries
              // which aged out during the drain window are not counted against the cap.
              pruneOldRestarts(record, Date.now());
              if (record.restartsThisHour.length >= maxRestartsPerHour) {
                log.warn?.(
                  `[${channelId}:${accountId}] health-monitor: hit ${maxRestartsPerHour} restarts/hour limit after drain, skipping`,
                );
                continue;
              }
              await channelManager.stopChannel(channelId as ChannelId, accountId);
            }
            channelManager.resetRestartAttempts(channelId as ChannelId, accountId);
            await channelManager.startChannel(channelId as ChannelId, accountId);
            const restartedAt = Date.now();
            record.lastRestartAt = restartedAt;
            record.restartsThisHour.push({ at: restartedAt });
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
      `started (interval: ${Math.round(checkIntervalMs / 1000)}s, startup-grace: ${Math.round(timing.monitorStartupGraceMs / 1000)}s, channel-connect-grace: ${Math.round(timing.channelConnectGraceMs / 1000)}s)`,
    );
  }

  return { stop };
}
