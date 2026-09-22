import type { DoctorConfigPreflightOptions } from "./doctor/shared/config-migration-result.js";

export async function withDoctorConfigPreflightWorkerScope<T>(
  options: DoctorConfigPreflightOptions,
  run: () => Promise<T>,
): Promise<T> {
  // Reuse child imports for this state operation; every read still acquires fresh admission.
  // The scope joins its child after the preflight releases its migration lease and heartbeat.
  if (
    options.migrateState !== false &&
    (options.requireStartupMigrationCheckpoint === true ||
      options.doctorOnlyStateMigrations === true)
  ) {
    const { withSqliteReadOnlyWorkerScope } = await import("../infra/sqlite-readonly-worker.js");
    return await withSqliteReadOnlyWorkerScope(run);
  }
  return await run();
}
