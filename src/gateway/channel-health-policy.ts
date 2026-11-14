import {
  asFiniteNumber,
  resolveNonNegativeIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import type { ChannelAccountSnapshot, ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import { resolveChannelAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";

type ChannelHealthSnapshot = Omit<ChannelAccountSnapshot, "accountId">;

type HealthMonitorConfig = {
  healthMonitor?: {
    enabled?: boolean;
  };
};

type ChannelHealthMonitorConfig = HealthMonitorConfig & {
  accounts?: Record<string, HealthMonitorConfig>;
};

function resolveAccountHealthMonitorOverride(
  channelConfig: ChannelHealthMonitorConfig | undefined,
  channelId: ChannelId,
  accountId: string,
): boolean | undefined {
  if (!channelConfig?.accounts) {
    return undefined;
  }
  const direct = resolveChannelAccountEntry(channelConfig.accounts, accountId, channelId);
  if (typeof direct?.healthMonitor?.enabled === "boolean") {
    return direct.healthMonitor.enabled;
  }
  const normalizedAccountId = normalizeOptionalAccountId(accountId);
  if (!normalizedAccountId) {
    return undefined;
  }
  const match = resolveChannelAccountEntry(
    channelConfig.accounts,
    normalizedAccountId,
    channelId,
    normalizeAccountId,
  );
  if (typeof match?.healthMonitor?.enabled !== "boolean") {
    return undefined;
  }
  return match.healthMonitor.enabled;
}

export function resolveChannelHealthMonitorEnabled(
  cfg: OpenClawConfig,
  channelId: ChannelId,
  accountId: string,
): boolean {
  // SAFETY: Open-world plugin fields are optional; enabled values are checked as booleans.
  const channelConfig = cfg.channels?.[channelId] as ChannelHealthMonitorConfig | undefined;
  const accountOverride = resolveAccountHealthMonitorOverride(channelConfig, channelId, accountId);
  const channelOverride = channelConfig?.healthMonitor?.enabled;

  return accountOverride ?? (typeof channelOverride === "boolean" ? channelOverride : true);
}

export type ChannelHealthPolicy = {
  channelId: ChannelId;
  now: number;
  staleEventThresholdMs: number;
  channelConnectGraceMs: number;
};

/** Keep channel-authored terminal detail above the shared unhealthy projection. */
export function resolveChannelHealthState(
  snapshot: ChannelHealthSnapshot,
  policy: ChannelHealthPolicy,
): string | undefined {
  const evaluation = evaluateChannelHealth(snapshot, policy);
  return !evaluation.healthy && !(snapshot.lifecycle === "blocked" && snapshot.healthState)
    ? evaluation.reason
    : snapshot.healthState;
}

const BUSY_ACTIVITY_STALE_THRESHOLD_MS = 25 * 60_000;
const CHANNEL_RECONNECT_GRACE_MS = 120_000;
// Keep these shared between the background health monitor and on-demand readiness
// probes so both surfaces evaluate channel lifecycle windows consistently.
export const DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS = 30 * 60_000;
export const DEFAULT_CHANNEL_CONNECT_GRACE_MS = 120_000;

export function evaluateChannelHealth(
  snapshot: ChannelHealthSnapshot,
  policy: ChannelHealthPolicy,
) {
  if (snapshot.enabled === false || snapshot.configured === false) {
    return { healthy: true, reason: "unmanaged" as const };
  }
  if (!snapshot.running && snapshot.terminalDisconnect) {
    return { healthy: false, reason: "terminal-disconnect" as const };
  }
  if (snapshot.lifecycle === "blocked") {
    return { healthy: false, reason: "blocked" as const };
  }
  // Transport liveness and inbound admission are independent failure domains: a
  // channel can hold a healthy socket and still admit nothing. This outranks the
  // lifecycle windows below -- including not-running, which is the state a failed
  // ingress start actually lands in -- so the cause survives instead of collapsing
  // into a generic crash. Absence is "unknown", never "fine"; readiness owns its
  // own restart-backoff tolerance in server/readiness.ts.
  if (snapshot.ingressUnavailable === true) {
    return { healthy: false, reason: "ingress-unavailable" as const };
  }
  // Ordinary unlinked accounts need no recovery, but losing linkage cannot hide
  // an already recorded failure (for example, a terminal session logout).
  if (snapshot.linked === false) {
    return { healthy: true, reason: "unmanaged" as const };
  }
  const lastStartAt = asFiniteNumber(snapshot.lastStartAt) ?? null;
  // Trust recorded starting/recovering only inside connect grace. Without a timestamp or after
  // the window, no progress is indistinguishable from a hang, so inference keeps restart authority.
  if (
    (snapshot.lifecycle === "starting" || snapshot.lifecycle === "recovering") &&
    lastStartAt !== null &&
    policy.now - lastStartAt < policy.channelConnectGraceMs
  ) {
    return { healthy: true, reason: "startup-connect-grace" as const };
  }
  if (snapshot.lifecycle === "stopped" || !snapshot.running) {
    return { healthy: false, reason: "not-running" as const };
  }
  const activeRuns = resolveNonNegativeIntegerOption(snapshot.activeRuns, 0);
  const isBusy = snapshot.busy === true || activeRuns > 0;
  const lastRunActivityAt = asFiniteNumber(snapshot.lastRunActivityAt) ?? null;
  const activeRunStartedAt = asFiniteNumber(snapshot.activeRunStartedAt) ?? null;
  const lastTransportActivityAt = asFiniteNumber(snapshot.lastTransportActivityAt) ?? null;
  const busyStateInitializedForLifecycle =
    lastStartAt == null || (lastRunActivityAt != null && lastRunActivityAt >= lastStartAt);

  // Runtime snapshots are patch-merged, so a restarted lifecycle can temporarily
  // inherit stale busy fields from the previous instance. Ignore busy short-circuit
  // until run activity is known to belong to the current lifecycle.
  if (isBusy && busyStateInitializedForLifecycle) {
    const runActivityAge =
      lastRunActivityAt == null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, policy.now - lastRunActivityAt);
    const disconnectedRunStartAge =
      snapshot.connected === false && activeRunStartedAt != null
        ? Math.max(0, policy.now - activeRunStartedAt)
        : 0;
    const busyAge = Math.max(runActivityAge, disconnectedRunStartAge);
    if (busyAge < BUSY_ACTIVITY_STALE_THRESHOLD_MS) {
      return { healthy: true, reason: "busy" as const };
    }
    return { healthy: false, reason: "stuck" as const };
  }
  if (snapshot.lifecycle === undefined && lastStartAt !== null) {
    const upDuration = policy.now - lastStartAt;
    if (upDuration < policy.channelConnectGraceMs) {
      return { healthy: true, reason: "startup-connect-grace" as const };
    }
  }
  if (snapshot.connected === false) {
    const lastDisconnectAt =
      snapshot.lastDisconnect && typeof snapshot.lastDisconnect !== "string"
        ? (asFiniteNumber(snapshot.lastDisconnect.at) ?? null)
        : null;
    // A disconnect is current only when its producer recorded it inside this
    // account lifecycle; patch-merged timestamps from prior runs grant no grace.
    const disconnectBelongsToLifecycle =
      lastDisconnectAt != null && (lastStartAt == null || lastDisconnectAt >= lastStartAt);
    if (
      disconnectBelongsToLifecycle &&
      Math.max(0, policy.now - lastDisconnectAt) < CHANNEL_RECONNECT_GRACE_MS
    ) {
      return { healthy: true, reason: "reconnect-grace" as const };
    }
    return { healthy: false, reason: "disconnected" as const };
  }
  // App-level events are not socket liveness: quiet Slack/Discord workspaces can
  // go idle while their upstream clients maintain heartbeats internally.
  const shouldCheckStaleSocket = snapshot.connected === true && lastTransportActivityAt != null;
  if (shouldCheckStaleSocket) {
    if (lastStartAt != null && lastTransportActivityAt < lastStartAt) {
      if (policy.now - lastStartAt <= policy.staleEventThresholdMs) {
        return { healthy: true, reason: "healthy" as const };
      }
      return { healthy: false, reason: "stale-socket" as const };
    }
    const eventAge = policy.now - lastTransportActivityAt;
    if (eventAge > policy.staleEventThresholdMs) {
      return { healthy: false, reason: "stale-socket" as const };
    }
  }
  return { healthy: true, reason: "healthy" as const };
}

export function resolveChannelRestartReason(
  snapshot: ChannelHealthSnapshot,
  evaluation: ReturnType<typeof evaluateChannelHealth>,
): "gave-up" | "stopped" | "stale-socket" | "stuck" | "disconnected" | "ingress-unavailable" {
  // Restart reasons are intentionally coarse: downstream logs/UI need stable
  // categories, while detailed channel state stays in the health snapshot.
  if (
    evaluation.reason === "stale-socket" ||
    evaluation.reason === "ingress-unavailable" ||
    evaluation.reason === "disconnected"
  ) {
    return evaluation.reason;
  }
  if (evaluation.reason === "not-running") {
    return snapshot.reconnectAttempts && snapshot.reconnectAttempts >= 10 ? "gave-up" : "stopped";
  }
  return "stuck";
}
