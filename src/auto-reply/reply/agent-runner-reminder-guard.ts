import { loadCronStore, resolveCronStorePath } from "../../cron/store.js";
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

/**
 * Returns true when the cron store has at least one enabled job related to the
 * current session. Checks both:
 * 1. Jobs that share the same sessionKey (main-session crons)
 * 2. Jobs created by the same agentId with sessionTarget "isolated" (#43292)
 *
 * Used to suppress the "no reminder scheduled" guard note when an existing cron
 * (created in a prior turn) already covers the commitment.
 */
export async function hasSessionRelatedCronJobs(params: {
  cronStorePath?: string;
  sessionKey?: string;
  agentId?: string;
}): Promise<boolean> {
  try {
    const storePath = resolveCronStorePath(params.cronStorePath);
    const store = await loadCronStore(storePath);
    if (store.jobs.length === 0) {
      return false;
    }
    return store.jobs.some((job) => {
      if (!job.enabled) {
        return false;
      }
      // Match by session key (main-session crons)
      if (params.sessionKey && job.sessionKey === params.sessionKey) {
        return true;
      }
      // Match isolated crons that share the same agent (#43292)
      if (params.agentId && job.agentId === params.agentId && job.sessionTarget === "isolated") {
        return true;
      }
      return false;
    });
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
