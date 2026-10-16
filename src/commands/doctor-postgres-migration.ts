import { randomUUID } from "node:crypto";
import { capturePostgresBackup } from "../snapshot/database-backup.js";
import { stateEngineInput } from "../state/openclaw-state-db-engine.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

/** Retain the exact predecessor under the same custody as the version runner. */
export async function backupDoctorPostgresMigration(
  env: NodeJS.ProcessEnv,
  maintenance: { assertAdmission(): void },
): Promise<string[]> {
  const sourcePath = resolveOpenClawStateSqlitePath(env);
  const input = stateEngineInput();
  if (!input) {
    throw new Error("PostgreSQL migration backup requires the selected database engine");
  }
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
