import { loadCronStore, resolveCronStorePath } from "../../cron/store.js";
import type { CronJob } from "../../cron/types.js";
import type { ReplyPayload } from "../types.js";

export const UNSCHEDULED_REMINDER_NOTE =
  "Note: I did not schedule a reminder in this turn, so this will not trigger automatically.";

const REMINDER_COMMITMENT_PATTERNS: RegExp[] = [
  /\b(?:i\s*['’]?ll|i will)\s+(?:make sure to\s+)?(?:remember|remind|ping|follow up|follow-up|check back|circle back)\b/i,
  /\b(?:i\s*['’]?ll|i will)\s+(?:set|create|schedule)\s+(?:a\s+)?reminder\b/i,
];

export function hasUnbackedReminderCommitment(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) {
    return false;
  }
  if (normalized.includes(UNSCHEDULED_REMINDER_NOTE.toLowerCase())) {
    return false;
  }
  return REMINDER_COMMITMENT_PATTERNS.some((pattern) => pattern.test(text));
}

function isReminderSweepLikeCronJob(job: CronJob): boolean {
  if (!job.enabled || job.payload.kind !== "agentTurn") {
    return false;
  }
  const haystack = [job.name, job.payload.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .toLowerCase();
  if (!haystack) {
    return false;
  }
  return /(remind(?:er)?|sweep|due reminders?|check reminders?)/i.test(haystack);
}

/**
 * Returns true when the cron store has an enabled job that likely backs a
 * reminder promise made in the current turn.
 *
 * We suppress the guard note in two cases:
 * 1. a cron job shares the current session key (existing behavior), or
 * 2. an enabled isolated agent cron already looks like a reminder sweep job,
 *    which covers agent-persisted reminder architectures (#52528).
 */
export async function hasSessionRelatedCronJobs(params: {
  cronStorePath?: string;
  sessionKey?: string;
}): Promise<boolean> {
  try {
    const storePath = resolveCronStorePath(params.cronStorePath);
    const store = await loadCronStore(storePath);
    if (store.jobs.length === 0) {
      return false;
    }
    if (
      params.sessionKey &&
      store.jobs.some((job) => job.enabled && job.sessionKey === params.sessionKey)
    ) {
      return true;
    }
    return store.jobs.some((job) => isReminderSweepLikeCronJob(job));
  } catch {
    // If we cannot read the cron store, do not suppress the note.
    return false;
  }
}

export function appendUnscheduledReminderNote(payloads: ReplyPayload[]): ReplyPayload[] {
  let appended = false;
  return payloads.map((payload) => {
    if (appended || payload.isError || typeof payload.text !== "string") {
      return payload;
    }
    if (!hasUnbackedReminderCommitment(payload.text)) {
      return payload;
    }
    appended = true;
    const trimmed = payload.text.trimEnd();
    return {
      ...payload,
      text: `${trimmed}\n\n${UNSCHEDULED_REMINDER_NOTE}`,
    };
  });
}
