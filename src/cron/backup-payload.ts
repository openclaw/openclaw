export const CRON_BACKUP_CREATE_KIND = "backupCreate" as const;

export type CronBackupCreatePayload = {
  kind: typeof CRON_BACKUP_CREATE_KIND;
  output?: string;
  includeWorkspace?: boolean;
  onlyConfig?: boolean;
  verify?: boolean;
};

export type CronBackupCreatePayloadPatch = CronBackupCreatePayload;

export function isCronBackupCreatePayload(
  payload: { kind?: unknown } | null | undefined,
): payload is CronBackupCreatePayload {
  return payload?.kind === CRON_BACKUP_CREATE_KIND;
}
