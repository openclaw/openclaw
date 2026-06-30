// Gateway readiness checker for channel health and startup sidecar state.
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
  type ChannelHealthPolicy,
  type ChannelHealthEvaluation,
} from "../channel-health-policy.js";
import type { ChannelManager } from "../server-channels.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

/** Snapshot returned by the gateway readiness probe. */
export type ReadinessResult = {
  ready: boolean;
  failing: string[];
  uptimeMs: number;
  eventLoop?: GatewayEventLoopHealth;
};

/** Function form used by HTTP readiness endpoints and tests. */
export type ReadinessChecker = () => ReadinessResult;

const DEFAULT_READINESS_CACHE_TTL_MS = 10_000;
const log = createSubsystemLogger("gateway/readiness");

function shouldIgnoreReadinessFailure(
  accountSnapshot: ChannelAccountSnapshot,
  health: ChannelHealthEvaluation,
): boolean {
  if (health.reason === "unmanaged" || health.reason === "stale-socket") {
    return true;
  }
  // Channel restarts spend time in backoff with running=false before the next
  // lifecycle re-enters startup grace. Keep readiness green during that handoff
  // window, but still surface hard failures once restart attempts are exhausted.
  return health.reason === "not-running" && accountSnapshot.restartPending === true;
}

/** Create a cached readiness checker over channel runtime health. */
export function createReadinessChecker(deps: {
  channelManager: ChannelManager;
  startedAt: number;
  getStartupPending?: () => boolean;
  getStartupPendingReason?: () => string | undefined;
  getGatewayDraining?: () => boolean;
  getEventLoopHealth?: () => GatewayEventLoopHealth | undefined;
  shouldSkipChannelReadiness?: () => boolean;
  cacheTtlMs?: number;
}): ReadinessChecker {
  const { channelManager, startedAt } = deps;
  const cacheTtlMs = Math.max(0, deps.cacheTtlMs ?? DEFAULT_READINESS_CACHE_TTL_MS);
  let cachedAt = 0;
  let cachedState: Omit<ReadinessResult, "uptimeMs"> | null = null;

  return (): ReadinessResult => {
    const now = Date.now();
    const uptimeMs = now - startedAt;
    if (deps.getStartupPending?.()) {
      const reason = deps.getStartupPendingReason?.() ?? "startup-sidecars";
      return withEventLoopHealth(
        { ready: false, failing: [reason], uptimeMs },
        deps.getEventLoopHealth,
      );
    }
    if (deps.getGatewayDraining?.()) {
      return withEventLoopHealth(
        { ready: false, failing: ["gateway-draining"], uptimeMs },
        deps.getEventLoopHealth,
      );
    }
    if (deps.shouldSkipChannelReadiness?.()) {
      return withEventLoopHealth({ ready: true, failing: [], uptimeMs }, deps.getEventLoopHealth);
    }
    if (cachedState && now - cachedAt < cacheTtlMs) {
      return withEventLoopHealth({ ...cachedState, uptimeMs }, deps.getEventLoopHealth);
    }

    const snapshotStart = Date.now();
    const snapshot = channelManager.getRuntimeSnapshot();
    const snapshotMs = Date.now() - snapshotStart;
    const failing: string[] = [];

    const evaluationStart = Date.now();
    for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
      if (!accounts) {
        continue;
      }
      for (const accountSnapshot of Object.values(accounts)) {
        if (!accountSnapshot) {
          continue;
        }
        const policy: ChannelHealthPolicy = {
          now,
          staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
          channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
          channelId,
        };
        const health = evaluateChannelHealth(accountSnapshot, policy);
        if (!health.healthy && !shouldIgnoreReadinessFailure(accountSnapshot, health)) {
          failing.push(channelId);
          break;
        }
      }
    }
    const evaluationMs = Date.now() - evaluationStart;
    const totalMs = Date.now() - now;
    if (totalMs > 1000) {
      log.warn(
        `[readiness] slow evaluation totalMs=${totalMs} snapshotMs=${snapshotMs} evaluationMs=${evaluationMs} channels=${Object.keys(
          snapshot.channelAccounts,
        ).length}`,
      );
    }

    cachedAt = now;
    cachedState = { ready: failing.length === 0, failing };
    return withEventLoopHealth({ ...cachedState, uptimeMs }, deps.getEventLoopHealth);
  };
}

function withEventLoopHealth(
  result: ReadinessResult,
  getEventLoopHealth?: () => GatewayEventLoopHealth | undefined,
): ReadinessResult {
  const eventLoop = getEventLoopHealth?.();
  return eventLoop ? { ...result, eventLoop } : result;
}
