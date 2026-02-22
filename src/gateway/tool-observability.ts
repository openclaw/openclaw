type MetricTotals = {
  calls: number;
  errors: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  lastLatencyMs: number;
  lastAt: number;
};

type ToolMetricRow = MetricTotals & {
  tool: string;
  avgLatencyMs: number;
};

type ChannelMetricRow = MetricTotals & {
  channel: string;
  avgLatencyMs: number;
};

const DEFAULT_CHANNEL = "unknown";
const GENERIC_SESSION_PREFIXES = new Set(["agent", "main", "global"]);
const totalsByTool = new Map<string, MetricTotals>();
const totalsByChannel = new Map<string, MetricTotals>();
const totalsByToolChannel = new Map<string, Map<string, MetricTotals>>();

function emptyTotals(): MetricTotals {
  return {
    calls: 0,
    errors: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    lastLatencyMs: 0,
    lastAt: 0,
  };
}

function updateTotals(
  target: MetricTotals,
  params: { ok: boolean; latencyMs: number; now: number },
): void {
  target.calls += 1;
  if (!params.ok) {
    target.errors += 1;
  }
  target.totalLatencyMs += params.latencyMs;
  target.maxLatencyMs = Math.max(target.maxLatencyMs, params.latencyMs);
  target.lastLatencyMs = params.latencyMs;
  target.lastAt = params.now;
}

function deriveChannelFromSessionKey(sessionKey?: string): string {
  if (!sessionKey) {
    return DEFAULT_CHANNEL;
  }
  const prefix = sessionKey.split(":", 1)[0]?.trim().toLowerCase();
  if (!prefix || GENERIC_SESSION_PREFIXES.has(prefix)) {
    return DEFAULT_CHANNEL;
  }
  return prefix;
}

export function resolveGatewayMetricChannel(params: {
  messageChannel?: string | null;
  sessionKey?: string;
}): string {
  const explicit = params.messageChannel?.trim().toLowerCase();
  if (explicit) {
    return explicit;
  }
  return deriveChannelFromSessionKey(params.sessionKey);
}

export function recordGatewayToolInvocation(params: {
  tool: string;
  channel?: string;
  ok: boolean;
  latencyMs: number;
  now?: number;
}): void {
  const tool = params.tool.trim();
  if (!tool) {
    return;
  }
  const channel = params.channel?.trim().toLowerCase() || DEFAULT_CHANNEL;
  const latencyMs = Math.max(0, Math.floor(params.latencyMs));
  const now = params.now ?? Date.now();

  const perTool = totalsByTool.get(tool) ?? emptyTotals();
  updateTotals(perTool, { ok: params.ok, latencyMs, now });
  totalsByTool.set(tool, perTool);

  const perChannel = totalsByChannel.get(channel) ?? emptyTotals();
  updateTotals(perChannel, { ok: params.ok, latencyMs, now });
  totalsByChannel.set(channel, perChannel);

  const perToolChannelMap = totalsByToolChannel.get(tool) ?? new Map<string, MetricTotals>();
  const perToolChannel = perToolChannelMap.get(channel) ?? emptyTotals();
  updateTotals(perToolChannel, { ok: params.ok, latencyMs, now });
  perToolChannelMap.set(channel, perToolChannel);
  totalsByToolChannel.set(tool, perToolChannelMap);
}

function toRow<T extends { calls: number; totalLatencyMs: number }>(
  value: T,
): T & { avgLatencyMs: number } {
  const avgLatencyMs = value.calls > 0 ? Math.round(value.totalLatencyMs / value.calls) : 0;
  return { ...value, avgLatencyMs };
}

export function getGatewayToolMetricsSnapshot(params?: {
  topTools?: number;
  topChannels?: number;
}): {
  updatedAt: number;
  tools: ToolMetricRow[];
  channels: ChannelMetricRow[];
  byToolChannel: Array<{ tool: string; channels: ChannelMetricRow[] }>;
} {
  const topTools = Math.max(1, Math.min(200, Math.floor(params?.topTools ?? 25)));
  const topChannels = Math.max(1, Math.min(100, Math.floor(params?.topChannels ?? 25)));

  const tools = Array.from(totalsByTool.entries())
    .map(([tool, totals]) => toRow({ tool, ...totals }))
    .toSorted((a, b) => b.calls - a.calls || b.totalLatencyMs - a.totalLatencyMs)
    .slice(0, topTools);

  const channels = Array.from(totalsByChannel.entries())
    .map(([channel, totals]) => toRow({ channel, ...totals }))
    .toSorted((a, b) => b.calls - a.calls || b.totalLatencyMs - a.totalLatencyMs)
    .slice(0, topChannels);

  const byToolChannel = Array.from(totalsByToolChannel.entries())
    .map(([tool, channelMap]) => ({
      tool,
      channels: Array.from(channelMap.entries())
        .map(([channel, totals]) => toRow({ channel, ...totals }))
        .toSorted((a, b) => b.calls - a.calls || b.totalLatencyMs - a.totalLatencyMs)
        .slice(0, topChannels),
    }))
    .toSorted((a, b) => {
      const aCalls = a.channels.reduce((sum, row) => sum + row.calls, 0);
      const bCalls = b.channels.reduce((sum, row) => sum + row.calls, 0);
      return bCalls - aCalls;
    })
    .slice(0, topTools);

  return {
    updatedAt: Date.now(),
    tools,
    channels,
    byToolChannel,
  };
}

export function resetGatewayToolMetricsForTests(): void {
  totalsByTool.clear();
  totalsByChannel.clear();
  totalsByToolChannel.clear();
}
