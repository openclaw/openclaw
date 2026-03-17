import type { ChannelId } from "../channels/plugins/types.js";
import { isPassiveChannel, isPollingChannel } from "../infra/oag-channel-profiles.js";
import { resolveOagStalePollFactor } from "../infra/oag-config.js";

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
  lastInboundAt?: number | null;
  reconnectAttempts?: number;
  mode?: string;
};

export type ChannelHealthEvaluationReason =
  | "healthy"
  | "unmanaged"
  | "not-running"
  | "busy"
  | "stuck"
  | "startup-connect-grace"
  | "disconnected"
  | "stale-socket"
  | "stale-poll";

export type ChannelHealthEvaluation = {
  healthy: boolean;
  reason: ChannelHealthEvaluationReason;
};

export type ChannelHealthPolicy = {
  channelId: ChannelId;
  now: number;
  staleEventThresholdMs: number;
  channelConnectGraceMs: number;
  stalePollFactor?: number;
};

export type ChannelRestartReason =
  | "gave-up"
  | "stopped"
  | "stale-socket"
  | "stale-poll"
  | "stuck"
  | "disconnected";

export function isChannelOperational(
  snapshot: ChannelHealthSnapshot,
  policy: ChannelHealthPolicy,
): boolean {
  const evaluation = evaluateChannelHealth(snapshot, policy);
  return evaluation.healthy && evaluation.reason !== "startup-connect-grace";
}

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

  const isPollOrWebhook =
    isPollingChannel(policy.channelId) ||
    isPassiveChannel(policy.channelId) ||
    snapshot.mode === "webhook";

  if (!isPollOrWebhook && snapshot.connected === true && snapshot.lastEventAt != null) {
    // WebSocket-based channels: detect half-dead sockets via lastEventAt.
    if (lastStartAt != null && snapshot.lastEventAt < lastStartAt) {
      const lifecycleEventGap = Math.max(0, policy.now - lastStartAt);
      if (lifecycleEventGap <= policy.staleEventThresholdMs) {
        return { healthy: true, reason: "healthy" };
      }
      return { healthy: false, reason: "stale-socket" };
    }
    const eventAge = policy.now - snapshot.lastEventAt;
    if (eventAge > policy.staleEventThresholdMs) {
      return { healthy: false, reason: "stale-socket" };
    }
  }

  if (isPollOrWebhook) {
    // Polling/webhook channels: detect a crashed poller or stalled webhook
    // receiver via lastInboundAt. Use a more generous threshold since poll
    // intervals are typically longer than WebSocket event cadences.
    const lastInboundAt =
      typeof snapshot.lastInboundAt === "number" && Number.isFinite(snapshot.lastInboundAt)
        ? snapshot.lastInboundAt
        : null;
    if (lastInboundAt != null) {
      const stalePollThresholdMs =
        policy.staleEventThresholdMs * (policy.stalePollFactor ?? resolveOagStalePollFactor());
      if (lastStartAt != null && lastInboundAt < lastStartAt) {
        const lifecycleGap = Math.max(0, policy.now - lastStartAt);
        if (lifecycleGap <= stalePollThresholdMs) {
          return { healthy: true, reason: "healthy" };
        }
        return { healthy: false, reason: "stale-poll" };
      }
      const inboundAge = policy.now - lastInboundAt;
      if (inboundAge > stalePollThresholdMs) {
        return { healthy: false, reason: "stale-poll" };
      }
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
  if (evaluation.reason === "stale-poll") {
    return "stale-poll";
  }
  if (evaluation.reason === "not-running") {
    return snapshot.reconnectAttempts && snapshot.reconnectAttempts >= 10 ? "gave-up" : "stopped";
  }
  if (evaluation.reason === "disconnected") {
    return "disconnected";
  }
  return "stuck";
}
