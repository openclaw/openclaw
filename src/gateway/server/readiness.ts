import { evaluateChannelHealth, type ChannelHealthPolicy } from "../channel-health-policy.js";
import type { ChannelManager } from "../server-channels.js";

export type ReadinessResult = {
  ready: boolean;
  failing: string[];
  uptimeMs: number;
};

export type ReadinessChecker = () => ReadinessResult;

const DEFAULT_GRACE_MS = 120_000;
const DEFAULT_STALE_EVENT_THRESHOLD_MS = 30 * 60_000;
const DEFAULT_CHANNEL_CONNECT_GRACE_MS = 120_000;

export function createReadinessChecker(deps: {
  channelManager: ChannelManager;
  startedAt: number;
  graceMs?: number;
}): ReadinessChecker {
  const { channelManager, startedAt, graceMs = DEFAULT_GRACE_MS } = deps;

  return (): ReadinessResult => {
    const now = Date.now();
    const uptimeMs = now - startedAt;

    if (uptimeMs < graceMs) {
      return { ready: true, failing: [], uptimeMs };
    }

    const snapshot = channelManager.getRuntimeSnapshot();
    const failing: string[] = [];
    const policy: ChannelHealthPolicy = {
      now,
      staleEventThresholdMs: DEFAULT_STALE_EVENT_THRESHOLD_MS,
      channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
    };

    for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
      if (!accounts) {
        continue;
      }
      for (const accountSnapshot of Object.values(accounts)) {
        if (!accountSnapshot) {
          continue;
        }
        const health = evaluateChannelHealth(accountSnapshot, policy);
        if (!health.healthy && health.reason !== "unmanaged" && health.reason !== "stale-socket") {
          failing.push(channelId);
          break;
        }
      }
    }

    return { ready: failing.length === 0, failing, uptimeMs };
  };
}
