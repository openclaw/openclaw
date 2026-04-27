import type { ReplyPayload } from "../types.js";
export declare const UNSCHEDULED_REMINDER_NOTE = "Note: I did not schedule a reminder in this turn, so this will not trigger automatically.";
export declare function hasUnbackedReminderCommitment(text: string): boolean;
/**
 * Returns true when the cron store has at least one enabled job that shares the
 * current session key. Used to suppress the "no reminder scheduled" guard note
 * when an existing cron (created in a prior turn) already covers the commitment.
 */
export declare function hasSessionRelatedCronJobs(params: {
    cronStorePath?: string;
    sessionKey?: string;
}): Promise<boolean>;
export declare function appendUnscheduledReminderNote(payloads: ReplyPayload[]): ReplyPayload[];
