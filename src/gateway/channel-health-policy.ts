export type ChannelHealthSnapshot = {
  running?: boolean;
  connected?: boolean;
  enabled?: boolean;
  configured?: boolean;
  lastMessageAt?: number | null;
  busy?: boolean;
  activeRuns?: number;
  lastRunActivityAt?: number | null;
  lastEventAt?: number | null;
  lastStartAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
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
  now: number;
  staleEventThresholdMs: number;
  channelConnectGraceMs: number;
};

export type ChannelRestartReason = "gave-up" | "stopped" | "stale-socket" | "stuck";

function isManagedAccount(snapshot: ChannelHealthSnapshot): boolean {
  return snapshot.enabled !== false && snapshot.configured !== false;
}

const BUSY_ACTIVITY_STALE_THRESHOLD_MS = 25 * 60_000;

function toTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function latestActivityAt(snapshot: ChannelHealthSnapshot): number | null {
  const candidates = [
    toTimestamp(snapshot.lastEventAt),
    toTimestamp(snapshot.lastInboundAt),
    toTimestamp(snapshot.lastOutboundAt),
    toTimestamp(snapshot.lastMessageAt),
  ];
  let latest: number | null = null;
  for (const candidate of candidates) {
    if (candidate == null) {
      continue;
    }
    if (latest == null || candidate > latest) {
      latest = candidate;
    }
  }
  return latest;
}

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
  const currentStartAt = toTimestamp(snapshot.lastStartAt);
  if (currentStartAt != null) {
    const upDuration = policy.now - currentStartAt;
    if (upDuration < policy.channelConnectGraceMs) {
      return { healthy: true, reason: "startup-connect-grace" };
    }
  }
  if (snapshot.connected === false) {
    return { healthy: false, reason: "disconnected" };
  }
  const lastActivityAt = latestActivityAt(snapshot);
  if (lastActivityAt == null) {
    return { healthy: true, reason: "healthy" };
  }
  if (currentStartAt != null && lastActivityAt < currentStartAt) {
    return { healthy: true, reason: "healthy" };
  }
  const upDuration =
    currentStartAt == null ? Number.POSITIVE_INFINITY : policy.now - currentStartAt;
  if (upDuration > policy.staleEventThresholdMs) {
    const eventAge = policy.now - lastActivityAt;
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
