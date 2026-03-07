import type { ChannelId } from "../channels/plugins/types.js";

export type ChannelHealthSnapshot = {
  running?: boolean;
  connected?: boolean;
  enabled?: boolean;
  configured?: boolean;
  restartPending?: boolean;
  busy?: boolean;
  activeRuns?: number;
  lastRunActivityAt?: number | null;
  lastEventAt?: number | null;
  lastStartAt?: number | null;
  reconnectAttempts?: number;
};

export type ChannelHealthEvaluationReason =
  | "healthy"
  | "unmanaged"
  | "not-running"
  | "busy"
  | "stuck"
  | "startup-connect-grace"
  | "disconnected"
  | "stale-socket";

export type ChannelHealthEvaluation = {
  healthy: boolean;
  reason: ChannelHealthEvaluationReason;
};

export type ChannelHealthPolicy = {
  channelId: ChannelId;
  now: number;
  staleEventThresholdMs: number;
  channelConnectGraceMs: number;
};

export type ChannelRestartReason = "gave-up" | "stopped" | "stale-socket" | "stuck";

function isManagedAccount(snapshot: ChannelHealthSnapshot): boolean {
  return snapshot.enabled !== false && snapshot.configured !== false;
}

const BUSY_ACTIVITY_STALE_THRESHOLD_MS = 25 * 60_000;
// Keep these shared between the background health monitor and on-demand readiness
// probes so both surfaces evaluate channel lifecycle windows consistently.
export const DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS = 30 * 60_000;
export const DEFAULT_CHANNEL_CONNECT_GRACE_MS = 120_000;

export function evaluateChannelHealth(
  snapshot: ChannelHealthSnapshot,
  policy: ChannelHealthPolicy,
): ChannelHealthEvaluation {
  if (!isManagedAccount(snapshot)) {
    return { healthy: true, reason: "unmanaged" };
  }
  if (!snapshot.running) {
    return { healthy: false, reason: "not-running" };
  }
  const activeRuns =
    typeof snapshot.activeRuns === "number" && Number.isFinite(snapshot.activeRuns)
      ? Math.max(0, Math.trunc(snapshot.activeRuns))
      : 0;
  const isBusy = snapshot.busy === true || activeRuns > 0;
  const lastStartAt =
    typeof snapshot.lastStartAt === "number" && Number.isFinite(snapshot.lastStartAt)
      ? snapshot.lastStartAt
      : null;
  const lastRunActivityAt =
    typeof snapshot.lastRunActivityAt === "number" && Number.isFinite(snapshot.lastRunActivityAt)
      ? snapshot.lastRunActivityAt
      : null;
  const busyStateInitializedForLifecycle =
    lastStartAt == null || (lastRunActivityAt != null && lastRunActivityAt >= lastStartAt);

  // Runtime snapshots are patch-merged, so a restarted lifecycle can temporarily
  // inherit stale busy fields from the previous instance. Ignore busy short-circuit
  // until run activity is known to belong to the current lifecycle.
  if (isBusy) {
    if (!busyStateInitializedForLifecycle) {
      // Fall through to normal startup/disconnect checks below.
    } else {
      const runActivityAge =
        lastRunActivityAt == null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, policy.now - lastRunActivityAt);
      if (runActivityAge < BUSY_ACTIVITY_STALE_THRESHOLD_MS) {
        return { healthy: true, reason: "busy" };
      }
      if (
        policy.channelId !== "telegram" &&
        snapshot.connected === true &&
        snapshot.lastEventAt != null &&
        (lastStartAt == null || snapshot.lastEventAt >= lastStartAt)
      ) {
        const eventAge = Math.max(0, policy.now - snapshot.lastEventAt);
        if (eventAge <= policy.staleEventThresholdMs) {
          return { healthy: true, reason: "healthy" };
        }
      }
      return { healthy: false, reason: "stuck" };
    }
  }
  if (snapshot.lastStartAt != null) {
    const upDuration = policy.now - snapshot.lastStartAt;
    if (upDuration < policy.channelConnectGraceMs) {
      return { healthy: true, reason: "startup-connect-grace" };
    }
  }
  if (snapshot.connected === false) {
    return { healthy: false, reason: "disconnected" };
  }
  // Skip stale-socket check for Telegram (long-polling mode). Each polling request
  // acts as a heartbeat, so the half-dead WebSocket scenario this check is designed
  // to catch does not apply to Telegram's long-polling architecture.
  if (
    policy.channelId !== "telegram" &&
    snapshot.connected === true &&
    snapshot.lastEventAt != null
  ) {
    if (lastStartAt != null && snapshot.lastEventAt < lastStartAt) {
      return { healthy: true, reason: "healthy" };
    }
    const eventAge = policy.now - snapshot.lastEventAt;
    if (eventAge > policy.staleEventThresholdMs) {
      return { healthy: false, reason: "stale-socket" };
    }
  }
  return { healthy: true, reason: "healthy" };
}

export function resolveChannelRestartReason(
  snapshot: ChannelHealthSnapshot,
  evaluation: ChannelHealthEvaluation,
): ChannelRestartReason {
  if (evaluation.reason === "stale-socket") {
    return "stale-socket";
  }
  if (evaluation.reason === "not-running") {
    return snapshot.reconnectAttempts && snapshot.reconnectAttempts >= 10 ? "gave-up" : "stopped";
  }
  return "stuck";
}
