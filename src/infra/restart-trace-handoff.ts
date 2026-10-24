import { isRecord } from "@openclaw/normalization-core/record-coerce";

export function isRestartTraceHandoff(value: unknown): value is {
  startedAt: number;
  lastAt: number;
} {
  return (
    isRecord(value) &&
    typeof value.startedAt === "number" &&
    Number.isFinite(value.startedAt) &&
    typeof value.lastAt === "number" &&
    Number.isFinite(value.lastAt) &&
    value.startedAt > 0 &&
    value.lastAt >= value.startedAt &&
    value.lastAt - value.startedAt <= 10 * 60_000
  );
}
