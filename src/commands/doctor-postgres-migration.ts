import { randomUUID } from "node:crypto";
import type { DatabaseEngineInput } from "../infra/database-engine/types.js";
import { hasUpdateDoctorMigrationCapture } from "../infra/update-doctor-migration-attribution.js";
import { capturePostgresBackup, fingerprintPostgresBackup } from "../snapshot/database-backup.js";

/** Retain the exact predecessor under the same custody as the version runner. */
export async function backupDoctorPostgresMigration(
  sourcePath: string,
  input: NonNullable<DatabaseEngineInput>,
  maintenance: { assertAdmission(): void },
): Promise<{ changes: string[]; generation?: string }> {
  const directory = `${sourcePath}.pre-startup-migration-${randomUUID()}.postgres.bak`;
  const config = { database: { engine: "postgres" as const, postgres: input } };
  maintenance.assertAdmission();
  const before = hasUpdateDoctorMigrationCapture()
    ? undefined
    : await fingerprintPostgresBackup(sourcePath, config);
  maintenance.assertAdmission();
  await capturePostgresBackup({
    sourcePath,
    directory,
    profile: "exact",
    config,
    assertCurrent: () => maintenance.assertAdmission(),
  });
  const generation =
    before === undefined ? undefined : await fingerprintPostgresBackup(sourcePath, config);
  maintenance.assertAdmission();
  if (before !== undefined && before !== generation) {
    throw new Error(`PostgreSQL changed during its pre-migration backup: ${sourcePath}`);
  }
  return { changes: [`Saved pre-migration PostgreSQL backup: ${directory}`], generation };
}
