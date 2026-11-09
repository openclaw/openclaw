import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
} from "../../gateway/channel-health-policy.js";

export type UnhealthyChannelAccount = {
  channel: string;
  accountId: string;
  reason: string;
  terminalDisconnect: boolean;
};

/**
 * Find channel accounts that are unhealthy under the shared health policy,
 * using only the Gateway's recorded snapshots (read-only, no credential probes).
 * Transient states that the policy already treats as healthy (reconnect grace,
 * startup grace, busy) are not reported. Older snapshots that omit `running`
 * cannot prove a stopped runtime, so `not-running` is only reported when
 * `running === false`.
 */
export function collectUnhealthyChannelAccounts(
  payload: unknown,
  now: number = Date.now(),
): UnhealthyChannelAccount[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const accountsByChannel = (payload as Record<string, unknown>).channelAccounts;
  if (!accountsByChannel || typeof accountsByChannel !== "object") {
    return [];
  }
  const unhealthy: UnhealthyChannelAccount[] = [];
  for (const [channelId, accounts] of Object.entries(accountsByChannel)) {
    if (!Array.isArray(accounts)) {
      continue;
    }
    for (const account of accounts) {
      if (!account || typeof account !== "object") {
        continue;
      }
      const snapshot = account as ChannelAccountSnapshot;
      if (snapshot.enabled === false || snapshot.configured === false) {
        continue;
      }
      const accountId =
        typeof snapshot.accountId === "string" && snapshot.accountId.trim()
          ? snapshot.accountId
          : "default";
      const health = evaluateChannelHealth(snapshot, {
        channelId,
        now,
        channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
        staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
      });
      if (health.healthy) {
        continue;
      }
      if (health.reason === "not-running" && snapshot.running !== false) {
        continue;
      }
      unhealthy.push({
        channel: channelId,
        accountId,
        reason: health.reason,
        terminalDisconnect: snapshot.terminalDisconnect === true,
      });
    }
  }
  return unhealthy.toSorted((left, right) =>
    `${left.channel}/${left.accountId}`.localeCompare(`${right.channel}/${right.accountId}`),
  );
}

export function formatUnhealthyChannelAccount(account: UnhealthyChannelAccount): string {
  const label = `${account.channel}/${account.accountId}`;
  if (account.reason === "terminal-disconnect") {
    return `Channel ${label} is terminally disconnected (terminal-disconnect); reconnect will not recover it.`;
  }
  return `Channel ${label} is unhealthy (${account.reason}).`;
}
