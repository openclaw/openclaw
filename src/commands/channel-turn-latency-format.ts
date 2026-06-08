import type { DiagnosticStabilitySnapshot } from "../logging/diagnostic-stability.js";

type ChannelTurnSummary = NonNullable<DiagnosticStabilitySnapshot["summary"]["channelTurns"]>;
type ChannelTurnLatency = NonNullable<ChannelTurnSummary["latency"]>;
type ChannelTurnLatencyMetric = ChannelTurnLatency["messageAgeMs"];

type LatencyFormatStyle = {
  assign: "=" | ":";
  separator: " " | "/";
};

const CHANNEL_TURN_LATENCY_METRICS: Array<{
  label: string;
  metric: keyof Omit<ChannelTurnLatency, "bottleneck" | "recentSlow">;
}> = [
  { label: "messageAge", metric: "messageAgeMs" },
  { label: "receivedToStart", metric: "receivedToTurnStartMs" },
  { label: "startToDelivery", metric: "startToDeliveryMs" },
  { label: "startToCompletion", metric: "startToCompletionMs" },
];

export function formatChannelTurnLatencyMs(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unknown";
  }
  return `${Math.round(value)}ms`;
}

export function formatChannelTurnLatencyMetric(
  label: string,
  metric: ChannelTurnLatencyMetric | undefined,
  style: LatencyFormatStyle,
): string {
  if (!metric) {
    return "";
  }
  const fields = [
    `latest${style.assign}${formatChannelTurnLatencyMs(metric.latestMs)}`,
    `max${style.assign}${formatChannelTurnLatencyMs(metric.maxMs)}`,
    `p95${style.assign}${formatChannelTurnLatencyMs(metric.p95Ms)}`,
    `slow${style.assign}${metric.slowCount}/${metric.count}`,
  ];
  return `${label} ${fields.join(style.separator)}`;
}

export function formatChannelTurnLatencyMetrics(
  latency: ChannelTurnSummary["latency"],
  style: LatencyFormatStyle,
): string[] {
  if (!latency) {
    return [];
  }
  return CHANNEL_TURN_LATENCY_METRICS.map(({ label, metric }) =>
    formatChannelTurnLatencyMetric(label, latency[metric], style),
  ).filter(Boolean);
}
