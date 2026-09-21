import { formatErrorMessage } from "../infra/errors.js";
import { StartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
import {
  DoctorStateMigrationRefusalError,
  formatStartupMigrationFailure,
} from "../infra/state-migrations.messages.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import { throwStartupMigrationRefusal } from "./doctor-startup-migration-refusal.js";
import type { DoctorConfigPreflightOptions } from "./doctor/shared/config-migration-result.js";

export async function withDoctorConfigPreflightWorkerScope<T>(
  options: DoctorConfigPreflightOptions,
  run: (options: DoctorConfigPreflightOptions) => Promise<T>,
): Promise<T> {
  // Reuse child imports for this state operation; every read still acquires fresh admission.
  // The scope joins its child after the preflight releases its migration lease and heartbeat.
  if (
    options.migrateState !== false &&
    (options.requireStartupMigrationCheckpoint === true ||
      options.doctorOnlyStateMigrations === true)
  ) {
    const { withSqliteReadOnlyWorkerScope } = await import("../infra/sqlite-readonly-worker.js");
    return await withSqliteReadOnlyWorkerScope(async () => {
      if (!options.requireStartupMigrationCheckpoint) {
        return run(options);
      }
      try {
        const { beginDoctorMaintenance } = await import("./doctor-maintenance.js");
        // Image replacement has no updater. Borrow Doctor's stopped-writer owner,
        // without granting its managed-service stop/restart path a package root.
        const maintenance = await beginDoctorMaintenance({
          options: { repair: true, nonInteractive: true },
          root: null,
          runtime: defaultRuntime,
        });
        if (!maintenance) {
          throw new Error("Startup state migration requires Doctor maintenance ownership.");
        }
        try {
          return await maintenance.run(() =>
            run({ ...options, doctorOnlyStateMigrations: true, invocationPurpose: "startup" }),
          );
        } finally {
          await maintenance.release();
        }
      } catch (error) {
        if (error instanceof ExitError) {
          throw error;
        }
        const message =
          error instanceof DoctorStateMigrationRefusalError
            ? formatStartupMigrationFailure(
                error.stepReceipts
                  .filter((receipt) => receipt.outcome === "refused")
                  .flatMap((receipt) => receipt.warnings),
              )
            : formatErrorMessage(error);
        return throwStartupMigrationRefusal(
          message,
          new StartupMaintenanceRequiredError("state-migrations", message, { cause: error }),
        );
      }
    });
  }
  return await run(options);
}
