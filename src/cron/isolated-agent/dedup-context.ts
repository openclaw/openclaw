import type { CronJob } from "../types.js";

export const DEDUP_MAX_OUTPUTS = 5;
export const DEDUP_MAX_CHARS_PER_OUTPUT = 500;

export function buildDedupContextBlock(job: CronJob): string | undefined {
  if (job.payload.kind !== "agentTurn" || !job.payload.dedupContext) {
    return undefined;
  }
  const outputs = job.state.recentOutputs;
  if (!outputs || outputs.length === 0) {
    return undefined;
  }

  const tz = job.schedule.kind === "cron" ? job.schedule.tz : undefined;
  const lines = outputs.map((o) => {
    const date = new Date(o.timestamp);
    const formatted = tz
      ? date.toLocaleString("en-US", { timeZone: tz, dateStyle: "short", timeStyle: "short" })
      : date.toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" });
    return `- ${formatted}: ${o.text}`;
  });

  return [
    "[Your previous outputs for this scheduled task — avoid repeating the same content:]",
    ...lines,
  ].join("\n");
}
