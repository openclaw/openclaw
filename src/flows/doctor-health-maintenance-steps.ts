import type { DoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import {
  handDoctorPendingDecisionsToStop,
  traceDoctorMaintenancePending,
  type DoctorMaintenancePending,
  type DoctorPendingDecisions,
} from "../commands/doctor-maintenance-pending.js";
import type { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import type { DoctorOptions } from "../commands/doctor-prompter.js";
import * as doctorMode from "../commands/doctor-repair-mode.js";
import { DOCTOR_SQLITE_NOCOW_REPAIR_ENV } from "../commands/doctor/shared/update-phase.js";
import type { DoctorProgressMeasure } from "../infra/doctor-progress.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import { withSqliteSnapshotFailureScope } from "../infra/sqlite-error-diagnostics.js";
import { withSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import type { AgentDatabaseMigrationTarget } from "../infra/state-migrations.media-persistence-targets.js";
import { resolveCommandProcessSignal, withCommandProcessScope } from "../process/exec-spawn.js";
import type { RuntimeEnv } from "../runtime.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

type DoctorMaintenance = NonNullable<Awaited<ReturnType<typeof beginDoctorMaintenance>>>;

/**
 * The last steps inside the stop. They check what the repairs left before the Gateway
 * starts: external config it would refuse, database and workspace readiness (whose
 * migration-backup bookkeeping needs maintenance custody), and boot-failure history it
 * would otherwise act on. Returns undefined when external config refuses startup.
 */
export async function runDoctorStartupReadinessSteps(params: {
  ctx: DoctorHealthFlowContext;
  runtime: RuntimeEnv;
  measure: DoctorProgressMeasure;
  databaseTargets: readonly AgentDatabaseMigrationTarget[];
  resumeCapture?: () => void;
}): Promise<{ sqliteReclamationAgents?: readonly AgentDatabaseMigrationTarget[] } | undefined> {
  const { ctx, runtime, measure, databaseTargets } = params;
  const { checkDoctorExternalConfigPending, validateDoctorExternalConfigForStartup } =
    await import("./doctor-external-config.js");
  await traceDoctorMaintenancePending("external-config", checkDoctorExternalConfigPending);
  if (
    !(await measure("doctor.external-config", () =>
      validateDoctorExternalConfigForStartup(runtime),
    ))
  ) {
    return undefined;
  }
  const { assertDoctorMaintenanceReady } =
    await import("../commands/doctor-maintenance-inspection.js");
  // The readiness assertions only read; the step writes when it completes migration backups.
  await traceDoctorMaintenancePending("maintenance-ready", async () => {
    const { checkDoctorMigrationBackupsPending } =
      await import("../commands/doctor-migration-backup-artifacts.js");
    return checkDoctorMigrationBackupsPending(
      process.env,
      databaseTargets.map((target) => target.path),
    );
  });
  const readiness = await measure("doctor.maintenance-ready", () =>
    assertDoctorMaintenanceReady(ctx.cfg, process.env, runtime.log, databaseTargets),
  );
  let sqliteReclamationAgents: readonly AgentDatabaseMigrationTarget[] | undefined;
  if (!readiness.schemaPublicationDeferred) {
    sqliteReclamationAgents = databaseTargets;
    params.resumeCapture?.();
    if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_PROXY_ENABLED)) {
      const { initializeDebugProxyCaptureAsync } = await import("../proxy-capture/runtime.js");
      await initializeDebugProxyCaptureAsync("cli");
    }
  }
  const {
    countRepairableGatewayMaintenanceStartupFailures,
    repairGatewayMaintenanceStartupFailures,
  } = await import("../infra/gateway-boot-lifecycle.js");
  const [{ decideDoctorPendingFromLiveStores }, { resolveOpenClawStateSqlitePath }] =
    await Promise.all([
      import("../commands/doctor-live-store-pending.js"),
      import("../state/openclaw-state-db.paths.js"),
    ]);
  // Boot lifecycle records live in the state database.
  await traceDoctorMaintenancePending("boot-lifecycle", () =>
    decideDoctorPendingFromLiveStores([resolveOpenClawStateSqlitePath()], async () =>
      (await countRepairableGatewayMaintenanceStartupFailures()) > 0 ? "work" : "none",
    ),
  );
  repairGatewayMaintenanceStartupFailures();
  return { sqliteReclamationAgents };
}

/** Store rewrites that run after the checks, still under maintenance custody. */
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
}

/**
 * Work that needs no Gateway stop. It runs before the stop, beside the serving Gateway, so
 * a failure here is reported and never blocks the repairs that need the stop. Standalone
 * Doctor warms transcript archives; an updater already owns the stop.
 *
 * Before Doctor's own `--fix` stop (not an updater's, which has stopped the Gateway already)
 * it then decides every step's and contribution's pending answer and returns the handoff that
 * gives those decisions to the stop. The stop still runs every step.
 */
export async function runDoctorBeforeStop(params: {
  runtime: RuntimeEnv;
  measure: DoctorProgressMeasure;
  options: DoctorOptions;
  interactiveRepair: boolean;
  root: string | null;
  databasePreflight: DoctorDatabasePreflight | undefined;
  preflightOptions: { preserveSourceArtifacts?: true };
  automaticHeartbeatRepair: boolean;
  /** An updater delegated its write authority to this Doctor run. */
  delegated: boolean;
}): Promise<{ archives?: DoctorDatabasePreflight; handoff?: Disposable }> {
  const { options, measure } = params;
  const repairMode = doctorMode.resolveDoctorRepairMode(options);
  let archives: DoctorDatabasePreflight | undefined;
  if (
    !repairMode.updateInProgress &&
    (options.repair === true || options.yes === true || params.interactiveRepair)
  ) {
    const { prepareDoctorMaintenanceArchives } = await import("./doctor-health-startup.js");
    archives = await measure("doctor.archive-preparation", () =>
      prepareDoctorMaintenanceArchives(
        params.databasePreflight,
        params.runtime,
        params.preflightOptions,
      ),
    );
  }
  if (!repairMode.shouldRepair) {
    return { archives };
  }
  const decisions: DoctorPendingDecisions | undefined =
    repairMode.updateInProgress || params.delegated ? undefined : new Map();
  const { checkRetainedUpdateRuntimesPending, cleanupRetainedUpdateRuntimesBeforeMaintenance } =
    await import("../commands/doctor-retained-runtime.js");
  await traceDoctorMaintenancePending(
    "retained-runtimes",
    () => checkRetainedUpdateRuntimesPending(process.env),
    decisions,
  );
  try {
    await measure("doctor.retained-runtimes", () =>
      cleanupRetainedUpdateRuntimesBeforeMaintenance(process.env),
    );
  } catch (error) {
    params.runtime.error(formatErrorMessage(error));
  }
  if (!decisions) {
    return { archives };
  }
  const { decideDoctorPendingBeforeStop } = await import("./doctor-health-pending-before-stop.js");
  await decideDoctorPendingBeforeStop({
    options,
    runtime: params.runtime,
    root: params.root,
    preflight: archives,
    automaticHeartbeatRepair: params.automaticHeartbeatRepair,
    decisions,
  });
  return { archives, handoff: handDoctorPendingDecisionsToStop(decisions) };
}

/**
 * Diagnostics placed after the restart run once Doctor has restored the Gateway it stopped,
 * in the read-only scopes plain `openclaw doctor` uses beside a serving Gateway. After a
 * failed restore they still run; if they cannot, the earlier failure stays the outcome and
 * their absence is reported.
 */
async function runDoctorAfterRestartSteps(params: {
  ctx: DoctorHealthFlowContext | undefined;
  measure: DoctorProgressMeasure;
  failed: boolean;
}): Promise<void> {
  const { ctx } = params;
  if (!ctx?.afterRestartContributions?.length) {
    return;
  }
  const signal = resolveCommandProcessSignal(getAsyncWorkSignal());
  const { runDoctorAfterRestartContributions } = await import("./doctor-health-contributions.js");
  try {
    await params.measure("doctor.after-restart-diagnostics", () =>
      withSqliteSnapshotFailureScope(() =>
        withCommandProcessScope(
          () =>
            withSqliteReadOnlyWorkerScope(
              () => runDoctorAfterRestartContributions(ctx),
              signal ? { signal, deadlineOwnedByCaller: false } : undefined,
            ),
          signal,
        ),
      ),
    );
  } catch (error) {
    if (!params.failed) {
      throw error;
    }
    ctx.runtime.error(
      `Doctor could not run its diagnostics after the failed Gateway restore: ${formatErrorMessage(error)}`,
    );
  }
}

/** Restores the Gateway, then runs the after-restart diagnostics whatever the restore did. */
export async function finishDoctorMaintenanceThenDiagnose(params: {
  ctx: DoctorHealthFlowContext | undefined;
  measure: DoctorProgressMeasure;
  failed: boolean;
  finish: () => Promise<void>;
}): Promise<void> {
  let failed = params.failed;
  try {
    await params.measure("doctor.maintenance.finish", params.finish);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await runDoctorAfterRestartSteps({ ctx: params.ctx, measure: params.measure, failed });
  }
}
