import { randomUUID } from "node:crypto";
import type { DatabaseEngineInput } from "../infra/database-engine/types.js";
import { capturePostgresBackup } from "../snapshot/database-backup.js";

/** Retain the exact predecessor under the same custody as the version runner. */
export async function backupDoctorPostgresMigration(
  sourcePath: string,
  input: NonNullable<DatabaseEngineInput>,
  maintenance: { assertAdmission(): void },
): Promise<string[]> {
  const directory = `${sourcePath}.pre-startup-migration-${randomUUID()}.postgres.bak`;
  await capturePostgresBackup({
    sourcePath,
    directory,
    profile: "exact",
    config: { database: { engine: "postgres", postgres: input } },
    assertCurrent: () => maintenance.assertAdmission(),
  });
  return [`Saved pre-migration PostgreSQL backup: ${directory}`];
}
