import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";

const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000;

export function normalizeMessageTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return asDateTimestampMs(
    value < EPOCH_MILLISECONDS_THRESHOLD ? Math.trunc(value * 1_000) : value,
  );
}
