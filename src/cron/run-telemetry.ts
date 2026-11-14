import { hasNonzeroUsage, type NormalizedUsage } from "../agents/usage.js";
import type { CronRunTelemetry } from "./types.js";

/** Project the execution owner's aggregate usage without recording it a second time. */
export function projectCronRunUsage(usage: NormalizedUsage | undefined): CronRunTelemetry["usage"] {
  if (!hasNonzeroUsage(usage)) {
    return undefined;
  }
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const bucketTotal = input + output + cacheRead + cacheWrite;
  const total =
    typeof usage.total === "number" && Number.isFinite(usage.total)
      ? Math.max(bucketTotal, usage.total)
      : bucketTotal;
  return {
    input_tokens: input,
    output_tokens: output,
    ...(total > 0 ? { total_tokens: total } : {}),
    ...(cacheRead > 0 ? { cache_read_tokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cache_write_tokens: cacheWrite } : {}),
  };
}
