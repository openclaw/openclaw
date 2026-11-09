import { randomUUID } from "node:crypto";
import type { DatabaseEngineInput } from "../infra/database-engine/types.js";
import { hasUpdateDoctorMigrationCapture } from "../infra/update-doctor-migration-attribution.js";
import {
  capturePostgresBackup,
  fingerprintPostgresBackup,
  prunePostgresSchemaCaptures,
} from "../snapshot/database-backup.js";

/** Retain the exact predecessor under the same custody as the version runner. */
export async function backupDoctorPostgresMigration(
  sourcePath: string,
  input: NonNullable<DatabaseEngineInput>,
  maintenance: { assertAdmission(): void },
): Promise<{ changes: string[]; generation?: string }> {
  const prefix = `${sourcePath}.pre-startup-migration-`;
  const directory = `${prefix}${randomUUID()}.postgres.bak`;
  const config = { database: { engine: "postgres" as const, postgres: input } };
  maintenance.assertAdmission();
  // Each capture's schema lives on the server; drop the ones whose backup was removed.
  const pruned = await prunePostgresSchemaCaptures(sourcePath, config, prefix);
  maintenance.assertAdmission();
  const before = hasUpdateDoctorMigrationCapture()
    ? undefined
    : await fingerprintPostgresBackup(sourcePath, config);
  await capturePostgresBackup({
    sourcePath,
    directory,
    profile: "exact",
    carrier: "postgres-schema",
    config,
    assertCurrent: () => maintenance.assertAdmission(),
  });
  const generation =
    before === undefined ? undefined : await fingerprintPostgresBackup(sourcePath, config);
  maintenance.assertAdmission();
  if (before !== undefined && before !== generation) {
    throw new Error(`PostgreSQL changed during its pre-migration backup: ${sourcePath}`);
  }
  return {
    changes: [
      ...pruned.map(
        (schema) =>
          `Dropped PostgreSQL capture schema ${schema}; its pre-migration backup was removed.`,
      ),
      `Saved pre-migration PostgreSQL backup: ${directory}`,
    ],
    generation,
  };
}
