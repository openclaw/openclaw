import type { DoctorConfigPreflightOptions } from "./doctor/shared/config-migration-result.js";

export async function withDoctorConfigPreflightWorkerScope<T>(
  options: DoctorConfigPreflightOptions,
  run: (options: DoctorConfigPreflightOptions) => Promise<T>,
): Promise<T> {
  // Reuse child imports for this state operation; every read still acquires fresh admission.
  if (options.migrateState !== false && options.doctorOnlyStateMigrations === true) {
    const { withSqliteReadOnlyWorkerScope } = await import("../infra/sqlite-readonly-worker.js");
    return await withSqliteReadOnlyWorkerScope(() => run(options));
  }
  return await run(options);
}
