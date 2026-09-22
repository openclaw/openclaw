import type { CronJob } from "./types.js";

export const SCHEDULED_BACKUP_DECLARATION_KEY = "openclaw-backup-scheduled";
export const SCHEDULED_BACKUP_COMMAND = ["openclaw", "backup", "git", "create"] as const;

/** Identifies the command contract emitted by backup enable, not its display label. */
export function isScheduledBackupCommand(
  job: Pick<CronJob, "declarationKey" | "payload">,
): boolean {
  const payload = job.payload;
  return (
    job.declarationKey === SCHEDULED_BACKUP_DECLARATION_KEY &&
    payload.kind === "command" &&
    SCHEDULED_BACKUP_COMMAND.every((part, index) => payload.argv[index] === part)
  );
}
