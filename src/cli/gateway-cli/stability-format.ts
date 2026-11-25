import { formatByteSize } from "@openclaw/normalization-core";
import type { DiagnosticStabilityEventRecord } from "../../logging/diagnostic-stability.js";

export function formatStabilityBytes(value: number | undefined): string {
  if (value === undefined) {
    return "n/a";
  }
  return formatByteSize(value, {
    style: "iec",
    maxUnit: "giga",
    separator: " ",
    fractionDigits: (amount, unit) => (unit === "byte" || amount >= 100 ? 0 : 1),
  });
}

export function formatStabilityEvent(record: DiagnosticStabilityEventRecord): string {
  const parts = [
    new Date(record.ts).toISOString(),
    `#${record.seq}`,
    record.type,
    record.provider ? `provider=${record.provider}` : "",
    record.model ? `model=${record.model}` : "",
    record.durationMs !== undefined ? `wall=${Math.round(record.durationMs)}ms` : "",
    record.providerProcessingMs !== undefined
      ? `processing=${Math.round(record.providerProcessingMs)}ms`
      : "",
    record.providerWaitEstimateMs !== undefined
      ? `wait~=${Math.round(record.providerWaitEstimateMs)}ms`
      : "",
    record.failureKind ? `failure=${record.failureKind}` : "",
    record.level ? `level=${record.level}` : "",
    record.action ? `action=${record.action}` : "",
    record.outcome ? `outcome=${record.outcome}` : "",
    record.surface ? `surface=${record.surface}` : "",
    record.channel ? `channel=${record.channel}` : "",
    record.pluginId ? `plugin=${record.pluginId}` : "",
    record.reason ? `reason=${record.reason}` : "",
    record.bytes !== undefined ? `bytes=${formatStabilityBytes(record.bytes)}` : "",
    record.limitBytes !== undefined ? `limit=${formatStabilityBytes(record.limitBytes)}` : "",
    record.queueDepth !== undefined ? `queueDepth=${record.queueDepth}` : "",
    record.queueLength !== undefined ? `queueLength=${record.queueLength}` : "",
    record.droppedEvents !== undefined ? `dropped=${record.droppedEvents}` : "",
    record.maxQueueLength !== undefined ? `maxQueue=${record.maxQueueLength}` : "",
    record.queued !== undefined ? `queued=${record.queued}` : "",
    record.memory ? `rss=${formatStabilityBytes(record.memory.rssBytes)}` : "",
    record.memory ? `heap=${formatStabilityBytes(record.memory.heapUsedBytes)}` : "",
  ].filter(Boolean);
  return parts.join(" ");
}
