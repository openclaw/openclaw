// Doctor `--fix` decides every step's and contribution's `pending` answer here, before it
// stops the Gateway, beside the serving Gateway that holds the stores open (a store nobody
// holds answers undecidable, see `decideDoctorPendingFromLiveStores`). The stop still runs
// every step as before; it receives these decisions and does not decide them again.
//
// Each answer assumes the steps before it change nothing. That holds exactly when they all
// answer none, the only case in which a stop could be skipped, so inputs that only an earlier
// step produces are taken in their no-change form: the config flow's result is the config on
// disk with nothing to write, and the stop's schema-maintenance custody is assumed for the
// migration-backup completion it would perform.
import { measureGatewayBootstrapStep } from "../cli/startup-trace.js";
import type { DoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import {
  traceDoctorMaintenancePending,
  type DoctorMaintenancePending,
  type DoctorMaintenancePendingCheck,
  type DoctorPendingDecisions,
} from "../commands/doctor-maintenance-pending.js";
import type { DoctorOptions, DoctorPrompter } from "../commands/doctor-prompter.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  retireIdleSqliteReadOnlyWorkers,
  withSqliteReadOnlyWorkerScope,
} from "../infra/sqlite-readonly-worker.js";
import { resolveCommandProcessSignal, withCommandProcessScope } from "../process/exec-spawn.js";
import type { RuntimeEnv } from "../runtime.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

/** The flow context the contributions meet when every step before them changed nothing. */
async function prepareUnchangedFlowContext(params: {
  options: DoctorOptions;
  runtime: RuntimeEnv;
  preflight: DoctorDatabasePreflight;
  prompter: DoctorPrompter;
}): Promise<DoctorHealthFlowContext> {
  const { createConfigIO } = await import("../config/io.factory.js");
  const snapshot = await createConfigIO({
    env: process.env,
    observe: false,
  }).readConfigFileSnapshot({ observe: false });
  // The config flow starts from the preflight's source config and returns it unchanged
  // when it has nothing to write (doctor-config-flow.ts, config-migration-result.ts).
  const cfg = snapshot.sourceConfig ?? snapshot.config ?? {};
  const version = snapshot.sourceConfig?.meta?.lastTouchedVersion;
  return {
    runtime: params.runtime,
    options: params.options,
    prompter: params.prompter,
    configResult: {
      cfg,
      path: snapshot.path,
      shouldWriteConfig: false,
      sourceConfigValid: snapshot.valid,
      ...(typeof version === "string" ? { sourceLastTouchedVersion: version } : {}),
      preflightLegacyStateConfig: cfg,
    },
    cfg,
    cfgForPersistence: structuredClone(cfg),
    sourceConfigValid: snapshot.valid,
    configPath: snapshot.path,
    gatewayMaintenanceActive: true,
    afterRestartContributions: [],
    agentDatabaseRefusals: params.preflight.agentRefusals ?? [],
  };
}

async function decideSteps(params: {
  options: DoctorOptions;
  root: string | null;
  preflight: DoctorDatabasePreflight;
  automaticHeartbeatRepair: boolean;
  prompter: DoctorPrompter;
  decide: (step: string, check?: DoctorMaintenancePendingCheck) => Promise<boolean>;
}): Promise<void> {
  const { options, preflight: schemas, prompter, decide } = params;
  const env = process.env;
  const integrityCheck = options.fullIntegrityCheck ? "full" : "quick";
  const [
    { resolvePendingLegacyStateDirMigrationPaths },
    startup,
    { checkDoctorDatabaseMigrationsPending },
  ] = await Promise.all([
    import("../infra/state-migrations.state-dir.js"),
    import("./doctor-health-startup.js"),
    import("../commands/doctor-heartbeat-migration-backup.js"),
  ]);
  await decide("legacy-state-dir", () =>
    resolvePendingLegacyStateDirMigrationPaths({ env }) ? "work" : "none",
  );
  await decide("client-credentials");
  await decide("state-database-repair", () =>
    startup.checkDoctorStateDatabaseRepairPending(integrityCheck),
  );
  await decide("database-migrations", () =>
    checkDoctorDatabaseMigrationsPending({
      schemas,
      env,
      automaticRepair: params.automaticHeartbeatRepair,
    }),
  );
  await decide("state-schema", () => startup.checkDoctorStateSchemaPending(schemas));
  await decide("runtime-checks", () =>
    startup.checkDoctorRuntimeChecksPending(schemas, params.root, prompter),
  );
  await startup.traceDoctorConfigFlowPending(decide, options, schemas);
}

async function decideContributions(
  ctx: DoctorHealthFlowContext,
  decide: (step: string, check?: DoctorMaintenancePendingCheck) => Promise<boolean>,
): Promise<void> {
  const [{ resolveDoctorFixContributions }, { resolveDoctorContributionPendingCheck }] =
    await Promise.all([
      import("./doctor-health-contributions.js"),
      import("./doctor-health-contribution-utils.js"),
    ]);
  for (const contribution of resolveDoctorFixContributions()) {
    await decide(
      `contribution.${contribution.id}`,
      resolveDoctorContributionPendingCheck(ctx, contribution),
    );
  }
}

async function decideReadinessSteps(params: {
  options: DoctorOptions;
  preflight: DoctorDatabasePreflight;
  decide: (step: string, check?: DoctorMaintenancePendingCheck) => Promise<boolean>;
}): Promise<void> {
  const { decide } = params;
  const targets = params.preflight.agentDatabaseMigrationDiscovery?.discovery.targets ?? [];
  const [
    { checkDoctorExternalConfigPending },
    { checkDoctorMigrationBackupsPending },
    { countRepairableGatewayMaintenanceStartupFailures },
    { decideDoctorPendingFromLiveStores },
    { resolveOpenClawStateSqlitePath },
    { checkDoctorSqliteNoCowPending, inspectDoctorSqliteNoCow },
  ] = await Promise.all([
    import("./doctor-external-config.js"),
    import("../commands/doctor-migration-backup-artifacts.js"),
    import("../infra/gateway-boot-lifecycle.js"),
    import("../commands/doctor-live-store-pending.js"),
    import("../state/openclaw-state-db.paths.js"),
    import("../commands/doctor-sqlite-nocow.js"),
  ]);
  await decide("external-config", checkDoctorExternalConfigPending);
  // The stop completes migration backups under its schema-maintenance custody.
  await decide("maintenance-ready", () =>
    checkDoctorMigrationBackupsPending(
      process.env,
      targets.map((target) => target.path),
      { ownsSchemaMaintenance: true },
    ),
  );
  await decide("boot-lifecycle", () =>
    decideDoctorPendingFromLiveStores([resolveOpenClawStateSqlitePath()], async () =>
      (await countRepairableGatewayMaintenanceStartupFailures()) > 0 ? "work" : "none",
    ),
  );
  if (params.options.repair === true) {
    await decide("sqlite-nocow", () =>
      checkDoctorSqliteNoCowPending(
        inspectDoctorSqliteNoCow([
          resolveOpenClawStateSqlitePath(),
          ...targets.map((target) => target.path),
        ]),
      ),
    );
  }
  // Restoring the stopped service may rewrite its definition; nothing decides that yet.
  await decide("service-definition");
}

function summarize(decisions: DoctorPendingDecisions) {
  const counts: Record<DoctorMaintenancePending, number> = { none: 0, work: 0, undecidable: 0 };
  const notNone: string[] = [];
  for (const [step, answer] of decisions) {
    counts[answer] += 1;
    if (answer !== "none") {
      notNone.push(`${step}:${answer}`);
    }
  }
  return { decisions: decisions.size, ...counts, notNone: notNone.join(",") || "-" };
}

/**
 * Decides, before the stop, every step and contribution Doctor's `--fix` traces, in the order
 * it reaches them, into `decisions` (which may already hold earlier pre-stop decisions), and traces
 * one summary, `doctor.pending-before-stop`, with counts by answer and every decision that
 * is not none. A failure here is traced and never blocks the stop.
 */
export async function decideDoctorPendingBeforeStop(params: {
  options: DoctorOptions;
  runtime: RuntimeEnv;
  root: string | null;
  preflight: DoctorDatabasePreflight | undefined;
  automaticHeartbeatRepair: boolean;
  decisions: DoctorPendingDecisions;
}): Promise<void> {
  const { decisions } = params;
  const decide = (step: string, check?: DoctorMaintenancePendingCheck) =>
    traceDoctorMaintenancePending(step, check, decisions);
  const signal = resolveCommandProcessSignal(getAsyncWorkSignal());
  let failure: string | undefined;
  await measureGatewayBootstrapStep(
    "doctor.pending-before-stop",
    async () => {
      try {
        await withCommandProcessScope(
          () =>
            withSqliteReadOnlyWorkerScope(
              async () => {
                const preflight =
                  params.preflight ??
                  (await (
                    await import("../commands/doctor-database-preflight.js")
                  ).prepareDoctorDatabasePreflight());
                const { createDoctorPrompter } = await import("../commands/doctor-prompter.js");
                const prompter = createDoctorPrompter({
                  runtime: params.runtime,
                  options: params.options,
                });
                await decideSteps({ ...params, preflight, prompter, decide });
                const ctx = await prepareUnchangedFlowContext({ ...params, preflight, prompter });
                await decideContributions(ctx, decide);
                await decideReadinessSteps({ options: params.options, preflight, decide });
              },
              // Its own scope, closed here rather than when the command exits.
              { signal: signal ?? new AbortController().signal, deadlineOwnedByCaller: false },
            ),
          signal,
        );
      } catch (error) {
        signal?.throwIfAborted();
        failure = formatErrorMessage(error).replace(/\s+/gu, "_").slice(0, 200);
      } finally {
        // Pooled readers outlive their scope with the stores open; none may hold one into
        // the stop.
        await retireIdleSqliteReadOnlyWorkers().catch((error: unknown) => {
          failure ??= `reader-retirement:${formatErrorMessage(error).replace(/\s+/gu, "_").slice(0, 160)}`;
        });
      }
    },
    () => ({ ...summarize(decisions), ...(failure ? { failed: failure } : {}) }),
  );
}
