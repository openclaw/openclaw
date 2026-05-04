import type { ChannelId } from "../channels/plugins/types.public.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
  type ChannelHealthEvaluationReason,
  type ChannelHealthPolicy,
  type ChannelHealthSnapshot,
} from "./channel-health-policy.js";
import type { ChannelRuntimeSnapshot } from "./server-channel-runtime.types.js";

type ChannelReasonCounts = Partial<Record<ChannelHealthEvaluationReason, number>>;

function inc(counts: ChannelReasonCounts, reason: ChannelHealthEvaluationReason) {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function formatReasonCounts(counts: ChannelReasonCounts): string {
  const ordered: ChannelHealthEvaluationReason[] = [
    "healthy",
    "startup-connect-grace",
    "busy",
    "unmanaged",
    "disconnected",
    "not-running",
    "stale-socket",
    "stuck",
  ];
  const parts = ordered
    .map((reason) => {
      const value = counts[reason];
      return value ? `${reason}=${value}` : null;
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "no-accounts";
}

export function summarizeChannelStartup(params: {
  snapshot: ChannelRuntimeSnapshot;
  now?: number;
}): {
  totalAccounts: number;
  failingChannels: ChannelId[];
  summaryLine: string;
} {
  const now = params.now ?? Date.now();

  const perChannel: Array<{ channelId: ChannelId; total: number; counts: ChannelReasonCounts }> = [];
  const failingChannels: ChannelId[] = [];
  let totalAccounts = 0;

  for (const [channelIdRaw, accounts] of Object.entries(params.snapshot.channelAccounts)) {
    const channelId = channelIdRaw as ChannelId;
    if (!accounts) {
      continue;
    }
    const counts: ChannelReasonCounts = {};
    let channelTotal = 0;
    let channelHealthy = true;

    for (const accountSnapshot of Object.values(accounts)) {
      if (!accountSnapshot) {
        continue;
      }
      channelTotal += 1;
      const policy: ChannelHealthPolicy = {
        now,
        staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
        channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
        channelId,
      };
      const health = evaluateChannelHealth(accountSnapshot as ChannelHealthSnapshot, policy);
      inc(counts, health.reason);
      if (!health.healthy) {
        channelHealthy = false;
      }
    }

    totalAccounts += channelTotal;
    if (channelTotal === 0) {
      continue;
    }
    if (!channelHealthy) {
      failingChannels.push(channelId);
    }
    perChannel.push({ channelId, total: channelTotal, counts });
  }

  failingChannels.sort((a, b) => a.localeCompare(b));
  perChannel.sort((a, b) => a.channelId.localeCompare(b.channelId));
  const failingLabel = failingChannels.length > 0 ? failingChannels.join(",") : "none";
  const channelParts = perChannel.map(
    (entry) => `${entry.channelId}[${entry.total}]: ${formatReasonCounts(entry.counts)}`,
  );

  const summaryLine =
    channelParts.length === 0
      ? `channels: 0 accounts; failing=${failingLabel}`
      : `channels: ${totalAccounts} accounts; failing=${failingLabel}; ${channelParts.join(" | ")}`;

  return { totalAccounts, failingChannels, summaryLine };
}

