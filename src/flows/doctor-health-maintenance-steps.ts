import { traceDoctorMaintenancePending } from "../commands/doctor-maintenance-pending.js";
import type { DoctorMaintenancePending } from "../commands/doctor-maintenance-pending.js";
import type { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import type { DoctorOptions } from "../commands/doctor-prompter.js";
import * as doctorMode from "../commands/doctor-repair-mode.js";
import { DOCTOR_SQLITE_NOCOW_REPAIR_ENV } from "../commands/doctor/shared/update-phase.js";
import type { DoctorProgressMeasure } from "../infra/doctor-progress.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { AgentDatabaseMigrationTarget } from "../infra/state-migrations.media-persistence-targets.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

type DoctorMaintenance = NonNullable<Awaited<ReturnType<typeof beginDoctorMaintenance>>>;

/** Store rewrites and runtime cleanup that run after the checks, still under maintenance custody. */
export async function runDoctorPostCheckMaintenance(params: {
  maintenance: DoctorMaintenance;
  ctx: DoctorHealthFlowContext;
  options: DoctorOptions;
  runtime: RuntimeEnv;
  measure: DoctorProgressMeasure;
  sqliteNoCow: { paths: string[]; pending: DoctorMaintenancePending };
  sqliteReclamationAgents: readonly AgentDatabaseMigrationTarget[] | undefined;
}): Promise<void> {
  const { maintenance, ctx, options, measure, sqliteNoCow } = params;
  if (options.repair === true) {
    await traceDoctorMaintenancePending("sqlite-nocow", () => sqliteNoCow.pending);
  }
  if (options.repair === true && sqliteNoCow.paths.length > 0) {
    if (
      doctorMode.resolveDoctorRepairMode(options).updateInProgress &&
      !isTruthyEnvValue(process.env[DOCTOR_SQLITE_NOCOW_REPAIR_ENV])
    ) {
      params.runtime.log(
        "SQLite NOCOW repair deferred: the managed updater did not request the store rewrite in this run.",
      );
    } else {
      await measure("doctor.sqlite-nocow", () => maintenance.repairSqliteNoCow(sqliteNoCow.paths));
    }
  }
  if (!ctx.prompter.shouldRepair) {
    return;
  }
  const agents = params.sqliteReclamationAgents;
  if (doctorMode.isDoctorUpdateRepairMode(ctx.prompter.repairMode) && agents) {
    await traceDoctorMaintenancePending("sqlite-reclamation");
    await measure("doctor.sqlite-reclamation", () => maintenance.enableSqliteReclamation(agents));
  }
  await traceDoctorMaintenancePending("retained-runtimes");
  await measure("doctor.retained-runtimes", () => maintenance.cleanupRetainedRuntimes());
}
