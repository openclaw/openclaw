import type { CronJob } from "../types.js";

export const OUTPUT_HISTORY_MAX_ENTRIES = 5;
/** Max characters to keep from each end when truncating long outputs. */
export const OUTPUT_HISTORY_HEAD_TAIL_CHARS = 300;

/** Truncate output text keeping the first and last N characters. */
export function truncateOutputForHistory(text: string): string {
  const limit = OUTPUT_HISTORY_HEAD_TAIL_CHARS * 2;
  if (text.length <= limit) {
    return text;
  }
  const head = text.slice(0, OUTPUT_HISTORY_HEAD_TAIL_CHARS);
  const tail = text.slice(-OUTPUT_HISTORY_HEAD_TAIL_CHARS);
  return `${head} … ${tail}`;
}

export function buildOutputHistoryBlock(job: CronJob): string | undefined {
  if (job.payload.kind !== "agentTurn" || !job.payload.outputHistory) {
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
    "[Your previous outputs for this scheduled task — use them as context for your next response:]",
    ...lines,
  ].join("\n");
}
