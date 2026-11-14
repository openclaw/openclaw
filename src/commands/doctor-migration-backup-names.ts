/**
 * Doctor's retained pre-migration original names. Producers build names here and readers
 * classify them here, so backup omission and restore validation cannot drift from the writers.
 */
export type DoctorMigrationBackupFormat =
  // `<db>.pre-startup-migration-<id>.bak`: full SQLite image.
  | "full"
  // `<db>.pre-startup-migration-<id>.scoped.bak`: scoped SQLite image.
  | "scoped"
  // `<db>.pre-startup-migration-<id>.postgres.bak`: PostgreSQL backup directory.
  | "postgres"
  // `<db>.pre-startup-migration-restart-recovery-<id>.bak`: SQLite image before restart-recovery repair.
  | "restart-recovery";

const PREFIX = ".pre-startup-migration-";
const RESTART_RECOVERY = "restart-recovery-";
const NAME_PATTERN = /^(restart-recovery-)?[a-f0-9-]{36}(\.scoped|\.postgres)?\.bak$/;
const NAMES: Record<DoctorMigrationBackupFormat, (backupId: string) => string> = {
  full: (backupId) => `${backupId}.bak`,
  scoped: (backupId) => `${backupId}.scoped.bak`,
  postgres: (backupId) => `${backupId}.postgres.bak`,
  "restart-recovery": (backupId) => `${RESTART_RECOVERY}${backupId}.bak`,
};

export function doctorMigrationBackupPath(
  databasePath: string,
  backupId: string,
  format: DoctorMigrationBackupFormat,
): string {
  return `${databasePath}${PREFIX}${NAMES[format](backupId)}`;
}

/** The Doctor format of `candidatePath` as an original of `databasePath`, by exact producer name. */
export function classifyDoctorMigrationBackupPath(
  databasePath: string,
  candidatePath: string,
): DoctorMigrationBackupFormat | undefined {
  const prefix = `${databasePath}${PREFIX}`;
  if (!candidatePath.startsWith(prefix)) {
    return undefined;
  }
  const match = NAME_PATTERN.exec(candidatePath.slice(prefix.length));
  if (!match) {
    return undefined;
  }
  if (match[1]) {
    return match[2] ? undefined : "restart-recovery";
  }
  return match[2] === ".scoped" ? "scoped" : match[2] === ".postgres" ? "postgres" : "full";
}

/** Any Doctor-produced pre-migration original of `databasePath`, file or PostgreSQL directory. */
export function isDoctorMigrationBackupPath(databasePath: string, candidatePath: string): boolean {
  return classifyDoctorMigrationBackupPath(databasePath, candidatePath) !== undefined;
}
