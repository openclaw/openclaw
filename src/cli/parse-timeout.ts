import { parseDurationMs } from "./parse-duration.js";

const durationSuffix = /[a-z]/i;

export function parseTimeoutMs(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  let value = Number.NaN;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "bigint") {
    value = Number(raw);
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    if (durationSuffix.test(trimmed)) {
      try {
        value = parseDurationMs(trimmed, { defaultUnit: "ms" });
      } catch {
        return undefined;
      }
    } else {
      value = Number.parseInt(trimmed, 10);
    }
  }
  return Number.isFinite(value) ? value : undefined;
}
