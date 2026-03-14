import type { CronJob } from "../types.js";

export const OUTPUT_HISTORY_MAX_ENTRIES = 5;
/** Max characters to keep from each end when truncating long outputs. */
export const OUTPUT_HISTORY_HEAD_TAIL_CHARS = 300;

/** Truncate output text keeping the first and last N characters. */
export function truncateOutputForHistory(text: string): string {
  const sep = " … ";
  const limit = OUTPUT_HISTORY_HEAD_TAIL_CHARS * 2;
  if (text.length <= limit) {
    return text;
  }
  const partLen = Math.floor((limit - sep.length) / 2);
  const head = text.slice(0, partLen);
  const tail = text.slice(-partLen);
  return `${head}${sep}${tail}`;
}

export function buildOutputHistoryBlock(job: CronJob): string | undefined {
  if (job.payload.kind !== "agentTurn" || !job.payload.outputHistory) {
    return undefined;
  }
  const raw = job.state.recentOutputs;
  if (!raw || raw.length === 0) {
    return undefined;
  }

  // Defense-in-depth: cap entries and text length at consumption to prevent
  // prompt blow-ups even if state was patched directly bypassing runtime guards.
  const outputs = raw.slice(-OUTPUT_HISTORY_MAX_ENTRIES);

  const rawTz = job.schedule.kind === "cron" ? job.schedule.tz?.trim() : undefined;
  const lines = outputs.map((o) => {
    const text = truncateOutputForHistory(o.text);
    const date = new Date(o.timestamp);
    let formatted: string;
    try {
      formatted = rawTz
        ? date.toLocaleString("en-US", { timeZone: rawTz, dateStyle: "short", timeStyle: "short" })
        : date.toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" });
    } catch {
      formatted = date.toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" });
    }
    return `- ${formatted}: ${text}`;
  });

  return [
    "[Your previous outputs for this scheduled task — use them as context for your next response:]",
    ...lines,
  ].join("\n");
}
