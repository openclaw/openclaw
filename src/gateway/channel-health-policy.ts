export type ChannelHealthSnapshot = {
  running?: boolean;
  connected?: boolean;
  enabled?: boolean;
  configured?: boolean;
  lastEventAt?: number | null;
  lastStartAt?: number | null;
  reconnectAttempts?: number;
};

export type ChannelHealthEvaluationReason =
  | "healthy"
  | "unmanaged"
  | "not-running"
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
  if (snapshot.lastStartAt != null) {
    const upDuration = policy.now - snapshot.lastStartAt;
    if (upDuration < policy.channelConnectGraceMs) {
      return { healthy: true, reason: "startup-connect-grace" };
    }
  }
  if (snapshot.connected === false) {
    return { healthy: false, reason: "disconnected" };
  }
  if (snapshot.lastEventAt != null || snapshot.lastStartAt != null) {
    const upSince = snapshot.lastStartAt ?? 0;
    const upDuration = policy.now - upSince;
    if (upDuration > policy.staleEventThresholdMs) {
      const lastEvent = snapshot.lastEventAt ?? 0;
      const eventAge = policy.now - lastEvent;
      if (eventAge > policy.staleEventThresholdMs) {
        return { healthy: false, reason: "stale-socket" };
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
  if (evaluation.reason === "not-running") {
    return snapshot.reconnectAttempts && snapshot.reconnectAttempts >= 10 ? "gave-up" : "stopped";
  }
  return "stuck";
}
