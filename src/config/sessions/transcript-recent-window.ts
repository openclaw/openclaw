import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";

export const normalizeTranscriptTimestamp = asFiniteNumber;

export function isWithinTranscriptWindow(
  timestamp: number | undefined,
  options: { beforeTimestampMs?: number; minTimestampMs?: number },
): boolean {
  return (
    (options.beforeTimestampMs === undefined ||
      timestamp === undefined ||
      timestamp < options.beforeTimestampMs) &&
    (options.minTimestampMs === undefined ||
      timestamp === undefined ||
      timestamp >= options.minTimestampMs)
  );
}

export function normalizeRecentTranscriptLimit(limit: number | undefined): number {
  return Math.max(1, Math.floor(limit ?? 10));
}

export function readPreferredUpstreamUserText(message: {
  __openclaw?: unknown;
}): string | null | undefined {
  const meta = asOptionalObjectRecord(message["__openclaw"]);
  if (typeof meta?.upstreamUserText === "string") {
    return meta.upstreamUserText.trim();
  }
  return meta?.mirrorOrigin ? null : undefined;
}
