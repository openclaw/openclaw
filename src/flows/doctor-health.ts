import type { BackupSqliteSnapshotFact } from "../commands/backup-resource-inventory.js";
import type { DoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import type {
  DoctorRepairEvidenceSink,
  ExternallyManagedDoctorRepairReport,
} from "../commands/doctor-externally-managed-repair.js";
import { createDoctorWriteAuthority } from "../commands/doctor-policy-custody.js";
import type { DoctorOptions } from "../commands/doctor-prompter.js";
import * as doctorMode from "../commands/doctor-repair-mode.js";
import * as updatePhase from "../commands/doctor/shared/update-phase.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { formatDoctorProgressPhase } from "../infra/doctor-progress.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { withSqliteSnapshotFailureScope } from "../infra/sqlite-error-diagnostics.js";
import { withSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import type { AgentDatabaseMigrationTarget } from "../infra/state-migrations.media-persistence-targets.js";
import { retainUpdateDoctorProcesses } from "../infra/update-doctor-process-custody.js";
import {
  captureUpdateDoctorConfigWrites,
  getUpdateDoctorConfigCapture,
  normalizeUpdatePostInstallDoctorWarnings,
  DoctorMaintenanceRefusalError,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  type UpdateDoctorWriteAuthority,
  type DoctorConfigCapture,
  type UpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import { formatUpdateFailureFact } from "../infra/update-failure-facts-format.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import { withPluginLoadDiagnostics } from "../plugins/load-diagnostics.js";
import type { PluginDiagnostic } from "../plugins/manifest-types.js";
import { resolveCommandProcessSignal, withCommandProcessScope } from "../process/exec-spawn.js";
import { withDeferredDebugProxyCapture } from "../proxy-capture/runtime-deferral.js";
import type { RuntimeEnv } from "../runtime.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { UpdateSchemaRefusalError } from "../state/openclaw-update-schema-refusal.js";
import {
  createDoctorHealthFindingBuffer,
  recordDoctorHealthWarnings,
  renderStructuredHealthFindings,
  showDoctorHealthSummary,
} from "./doctor-health-contribution.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";
import * as startup from "./doctor-health-startup.js";
import {
  createDoctorCompletedResult,
  createDoctorFailureResult,
  publishDoctorUpdateResult,
} from "./doctor-health-update-result.js";

/** Runs the full interactive doctor flow against the provided or default runtime. */
type DoctorHealthFlowResult<T extends DoctorOptions> = T["externallyManaged"] extends true
  ? ExternallyManagedDoctorRepairReport
  : void;

export async function runDoctorHealthFlow<TOptions extends DoctorOptions = DoctorOptions>(
  runtime?: RuntimeEnv,
  options?: TOptions,
  delegatedAuthority?: UpdateDoctorWriteAuthority,
  databasePreflight?: DoctorDatabasePreflight,
): Promise<DoctorHealthFlowResult<TOptions>> {
  const selectedOptions: DoctorOptions = options ?? {};
  const externallyManagedRepair = selectedOptions.externallyManaged
    ? (
        await import("../commands/doctor-externally-managed-repair.js")
      ).createExternallyManagedDoctorRepairEvidence()
    : undefined;
  const signal = resolveCommandProcessSignal(getAsyncWorkSignal());
  signal?.throwIfAborted();
  const writeAuthority = delegatedAuthority && createDoctorWriteAuthority(delegatedAuthority);
  using custody = await retainUpdateDoctorProcesses(
    writeAuthority?.assertCurrent,
    writeAuthority?.commandAuthority,
  );
  let requestedExit: (() => void) | undefined;
  const run = () =>
    withDeferredDebugProxyCapture(async (resumeCapture) => {
      let preparedPreflight = databasePreflight;
      // Snapshot-time generations must survive Doctor's own pre-maintenance reads.
      const preserveSourceArtifacts = writeAuthority?.databaseGenerations ? true : undefined;
      const preCaptureRehearsalRoot =
        !writeAuthority?.postCoreSchemaRepair &&
        (selectedOptions.repair === true || selectedOptions.yes === true)
          ? resolveUpdateRehearsalRoot(process.env)
          : undefined;
      if (
        process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1" &&
        !writeAuthority?.postCoreSchemaRepair
      ) {
        const { guardUpdateDoctorSchemaUpgrade, rehearseDeferredUpdateDoctorSchema } =
          await import("../commands/doctor-update-schema-guard.js");
        const guarded = await startup.withDoctorProgress(
          formatDoctorProgressPhase("Update schema admission"),
          () =>
            guardUpdateDoctorSchemaUpgrade({
              schemas: preparedPreflight,
              runtime,
              json: selectedOptions.json,
              statePublicationOnly: preCaptureRehearsalRoot !== undefined,
              preserveSourceArtifacts,
            }),
          selectedOptions.json !== true,
        );
        if (!preCaptureRehearsalRoot) {
          preparedPreflight = guarded ?? preparedPreflight;
        }
        if (!preCaptureRehearsalRoot && preparedPreflight?.updateSchemaRehearsal) {
          const rehearsal = preparedPreflight;
          await startup.withDoctorProgress(
            formatDoctorProgressPhase("Update schema rehearsal"),
            () =>
              rehearseDeferredUpdateDoctorSchema(
                rehearsal,
                runtime,
                selectedOptions.fullIntegrityCheck,
              ),
            selectedOptions.json !== true,
          );
          return;
        }
      }
      const resultPath = process.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim();
      return withPluginLoadDiagnostics((diagnostics) => {
        const runDoctor = (capture = getUpdateDoctorConfigCapture()) =>
          runDoctorHealthFlowWithResult(
            (selectedRuntime, code) => {
              requestedExit = () => startup.exitDoctorHealthFlow(selectedRuntime, code);
            },
            runtime,
            selectedOptions,
            preparedPreflight,
            diagnostics,
            capture ? { resultPath, capture } : undefined,
            writeAuthority,
            resumeCapture,
            preCaptureRehearsalRoot,
            externallyManagedRepair?.sink,
          );
        return resultPath
          ? captureUpdateDoctorConfigWrites(resolveConfigPath(), runDoctor, writeAuthority)
          : runDoctor();
      });
    });
  const { withPluginGenerationSourceCustody } =
    await import("../plugins/plugin-generation-source-lookup.js");
  try {
    await withPluginGenerationSourceCustody(() =>
      custody ? withCommandProcessScope(run, undefined, custody) : run(),
    ).catch(async (error: unknown) => {
      const { reportDoctorReadOnlyFilesystemError } =
        await import("../commands/doctor-maintenance-inspection.js");
      await reportDoctorReadOnlyFilesystemError(error, runtime);
      throw error;
    });
    signal?.throwIfAborted();
    if (!externallyManagedRepair) {
      requestedExit?.();
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (!externallyManagedRepair || error instanceof UpdateSchemaRefusalError) {
      throw error;
    }
    const { DoctorStateMigrationRefusalError } =
      await import("../infra/state-migrations.messages.js");
    if (error instanceof DoctorStateMigrationRefusalError) {
      externallyManagedRepair.sink.receipts(error.stepReceipts);
    }
    externallyManagedRepair.fail(error);
  }
  // SAFETY: only externally managed options create the report, matching the conditional return type.
  return externallyManagedRepair?.finish() as DoctorHealthFlowResult<TOptions>;
}

async function runDoctorHealthFlowWithResult(
  requestExit: (runtime: RuntimeEnv, code: number) => void,
  runtime: RuntimeEnv | undefined,
  options: DoctorOptions,
  databasePreflight: DoctorDatabasePreflight | undefined,
  diagnostics: readonly PluginDiagnostic[],
  updateResult?: { resultPath?: string; capture: DoctorConfigCapture },
  writeAuthority?: UpdateDoctorWriteAuthority,
  resumeCapture?: () => void,
  preCaptureRehearsalRoot?: string,
  repairEvidence?: DoctorRepairEvidenceSink,
) {
  const signal = resolveCommandProcessSignal(getAsyncWorkSignal());
  const measure = startup.createDoctorProgressMeasure(options);
  const renderOutro = options.json ? () => {} : startup.showDoctorOutro;
  const { effectiveRuntime, repairRuntime, stateDirExistedAtStart, root } = await measure(
    "doctor.startup",
    () =>
      startup.prepareDoctorHealthFlow(
        runtime,
        options,
        options.json ? () => {} : startup.showDoctorIntro,
      ),
  );
  let maintenance: Awaited<
    ReturnType<typeof import("../commands/doctor-maintenance.js").beginDoctorMaintenance>
  >;
  let sqliteNoCowPaths: string[] = [];
  const preflightOptions = {
    preserveSourceArtifacts: writeAuthority?.databaseGenerations ? (true as const) : undefined,
  };
  let sqliteReclamationAgents: readonly AgentDatabaseMigrationTarget[] | undefined;
  let exitCode: number | undefined;
  let healthContext: DoctorHealthFlowContext | undefined;
  const { buffer: startupFindings, reportFindings } = createDoctorHealthFindingBuffer(
    effectiveRuntime,
    repairEvidence,
  );
  let preparedArchiveDiscovery: DoctorDatabasePreflight["agentDatabaseMigrationDiscovery"];
  let doctorResult: UpdatePostInstallDoctorResult = { status: "error" };
  const recordRepairRefusal = (ctx: DoctorHealthFlowContext): boolean => {
    const refusal = startup.showDoctorRepairRefusal(ctx);
    if (!refusal) {
      return false;
    }
    exitCode = 1;
    doctorResult = refusal;
    return true;
  };
  const repairMode = doctorMode.resolveDoctorRepairMode(options);
  let interactiveRepair = false;
  let updateAdmissionComplete = false;
  if (repairMode.canPrompt && !repairMode.shouldRepair) {
    const admission = await measure("doctor.maintenance-admission", () =>
      startup.prepareDoctorInteractiveMaintenance({
        runtime: effectiveRuntime,
        options,
        databasePreflight,
        root,
        outro: renderOutro,
      }),
    );
    if (admission !== "accepted") {
      if (admission !== "handled") {
        requestExit(effectiveRuntime, admission.diagnosticExitCode);
      }
      return;
    }
    interactiveRepair = true;
    updateAdmissionComplete = true;
  }
  await using resources = new AsyncDisposableStack();
  resources.defer(async () => maintenance?.release());
  try {
    const { assertDoctorRetiredStateAdmission } =
      await import("../commands/doctor-retired-state-admission.js");
    assertDoctorRetiredStateAdmission();
    const { prepareAutomaticHeartbeatRepair } =
      await import("../commands/doctor-automatic-heartbeat-repair.js");
    const automaticHeartbeatRepair = await prepareAutomaticHeartbeatRepair(options);
    // Published updater markers opt only custody and backup into maintenance.
    const maintenanceOptions = automaticHeartbeatRepair ? { ...options, repair: true } : options;
    // Standalone Doctor warms archives before stopping the Gateway; update already owns the stop.
    if (
      !repairMode.updateInProgress &&
      (options.repair === true || options.yes === true || interactiveRepair)
    ) {
      preparedArchiveDiscovery = await measure("doctor.archive-preparation", () =>
        startup.prepareDoctorMaintenanceArchives(
          databasePreflight,
          effectiveRuntime,
          preflightOptions,
        ),
      );
    }
    const [{ beginDoctorMaintenance }, { createDoctorOriginalCaptureHook }] = await Promise.all([
      import("../commands/doctor-maintenance.js"),
      import("../commands/doctor-original-capture-admission.js"),
    ]);
    maintenance = await measure("doctor.maintenance.begin", () =>
      beginDoctorMaintenance({
        options: maintenanceOptions,
        interactiveRepair,
        root,
        runtime: repairRuntime,
        assertCurrent: writeAuthority?.assertCurrent,
        lendPolicyCustody: writeAuthority?.lendPolicyCustody,
        databaseGenerations: writeAuthority?.databaseGenerations,
        databaseWriteCapture: writeAuthority?.databaseWriteCapture,
        databasePluginOwners: writeAuthority?.databasePluginOwners,
        serviceInspectionDeadlineAtMs: writeAuthority?.serviceInspectionDeadlineAtMs,
        beforeStateMutation: createDoctorOriginalCaptureHook({
          root,
          runtime: repairRuntime,
          writeAuthority,
          rehearsalRoot: preCaptureRehearsalRoot,
          json: options.json,
          reportFindings,
          fullIntegrityCheck: options.fullIntegrityCheck,
        }),
      }),
    );
    const runChecks = async () => {
      signal?.throwIfAborted();
      const doctorRuntime = maintenance ? repairRuntime : effectiveRuntime;
      const { createDoctorPrompter } = await import("../commands/doctor-prompter.js");
      const { prepareDoctorDatabasePreflight } =
        await import("../commands/doctor-database-preflight.js");
      const prompter = createDoctorPrompter({
        runtime: doctorRuntime,
        options,
        signal: resolveCommandProcessSignal(maintenance?.signal ?? signal),
      });
      // Explicit repair never offers an update. Its current-state preflight remains
      // inside maintenance; diagnostic Doctor checks state before update admission.
      if (!maintenance && !updateAdmissionComplete) {
        if (!databasePreflight) {
          await measure("doctor.state-preflight", () =>
            prepareDoctorDatabasePreflight({ scope: "state" }),
          );
        }
        const { maybeOfferUpdateBeforeDoctor } = await import("../commands/doctor-update.js");
        const offeredUpdate = await maybeOfferUpdateBeforeDoctor({
          options,
          root,
          confirm: (p) => prompter.confirm(p),
          outro: renderOutro,
        });
        if (offeredUpdate) {
          return undefined;
        }
      }
      // An update may supply discovery from before maintenance excluded config publishers.
      const refreshRecoveryInventory =
        maintenance &&
        databasePreflight?.agentDatabaseMigrationDiscovery?.discovery.deletionJournal.status ===
          "unavailable";
      let schemas =
        databasePreflight && !refreshRecoveryInventory
          ? databasePreflight
          : await measure("doctor.database-preflight", () =>
              prepareDoctorDatabasePreflight(preflightOptions),
            );
      const { recordAgentDatabaseAdmissions } =
        await import("../state/agent-database-admission.js");
      // Repair owns fresh file decisions until its migration graph finishes.
      if (options.repair !== true && options.yes !== true) {
        recordAgentDatabaseAdmissions(schemas.agentRefusals ?? []);
      }
      const { guardUpdateDoctorSchemaUpgrade } =
        await import("../commands/doctor-update-schema-guard.js");
      let verifiedSnapshots: readonly BackupSqliteSnapshotFact[] = schemas.verifiedSnapshots ?? [];
      await measure("doctor.schema-admission", () =>
        guardUpdateDoctorSchemaUpgrade({
          schemas,
          runtime: doctorRuntime,
          json: options.json,
          postCoreSchemaRepair: writeAuthority?.postCoreSchemaRepair,
          signal: resolveCommandProcessSignal(maintenance?.signal ?? signal),
          onVerifiedBackup: (snapshots) => {
            verifiedSnapshots = snapshots;
          },
        }),
      );

      const { prepareDoctorClientCredentials } =
        await import("../commands/doctor-client-credentials.js");
      if (
        !(await prepareDoctorClientCredentials({
          runtime: doctorRuntime,
          options,
          prompter,
          maintenanceActive: maintenance !== undefined,
          schemas,
        }))
      ) {
        exitCode = 1;
        return undefined;
      }

      if (maintenance && (options.repair === true || options.yes === true)) {
        const repairedState = await measure("doctor.state-database-repair", () =>
          startup.repairDoctorStateDatabase(
            effectiveRuntime,
            options.fullIntegrityCheck ? "full" : "quick",
            (result) => repairEvidence?.migration("shared-state", result),
          ),
        );
        if (repairedState) {
          schemas = await measure("doctor.database-preflight", () =>
            prepareDoctorDatabasePreflight(),
          );
        }
      }
      if (maintenance) {
        const { prepareDoctorMigrationBackups } =
          await import("../commands/doctor-heartbeat-migration-backup.js");
        await prepareDoctorMigrationBackups({
          schemas,
          env: process.env,
          check: options.fullIntegrityCheck ? "full" : "quick",
          verifiedSnapshots,
          automaticRepair: Boolean(automaticHeartbeatRepair),
          onMigration: (stepId, result) => repairEvidence?.migration(stepId, result),
          runtime: effectiveRuntime,
          measure,
        });
      }

      const stateSchemaPreparation = await measure("doctor.state-schema", () =>
        startup.prepareDoctorStateSchema(
          schemas,
          prompter.shouldRepair,
          options.fullIntegrityCheck ? "full" : "quick",
        ),
      );
      const preparedRuntime = await startup.prepareDoctorRuntimeChecks(
        schemas,
        root,
        doctorRuntime,
        prompter,
        options,
        (result) => repairEvidence?.migration("agent-deletion-journal", result),
      );
      schemas = preparedRuntime.schemas;
      sqliteNoCowPaths = preparedRuntime.nocowPaths;
      repairEvidence?.remaining("runtime-state", preparedRuntime.warnings);

      const discovery = schemas.agentDatabaseMigrationDiscovery;
      if (discovery && discovery.stateDir === preparedArchiveDiscovery?.stateDir) {
        discovery.preparedTranscriptArchives = preparedArchiveDiscovery?.preparedTranscriptArchives;
      }
      const { loadAndMaybeMigrateDoctorConfig } = await import("../commands/doctor-config-flow.js");
      const configResult = await measure("doctor.config-flow", () =>
        loadAndMaybeMigrateDoctorConfig({
          options,
          retiredStateAdmitted: true,
          onStateMigrationMessage: (stepId, result) => repairEvidence?.migration(stepId, result),
          stateSchemaPreparation,
          ...(automaticHeartbeatRepair ? { automaticHeartbeatRepair } : {}),
          agentDatabaseMigrationDiscovery: schemas.agentDatabaseMigrationDiscovery,
          confirm: (p) => prompter.confirm(p),
          runtime: doctorRuntime,
          prompter,
          reportFindings,
        }),
      );
      resources.use(configResult);
      repairEvidence?.receipts(configResult.stateMigrationStepReceipts);
      if (!configResult.sourceConfigValid || configResult.shouldWriteConfig) {
        repairEvidence?.remaining("config", [
          "Deployment-owned config requires changes. Update the deployment source, redeploy it, then rerun Doctor repair.",
        ]);
      }
      // Relocation changes the inspected scope; unchanged fleets retain their prepared facts.
      const admissionSchemas =
        schemas.agentDatabaseMigrationDiscovery &&
        schemas.agentDatabaseMigrationDiscovery.stateDir !== resolveStateDir()
          ? await measure("doctor.database-preflight", () =>
              prepareDoctorDatabasePreflight({ cfg: configResult.cfg }),
            )
          : schemas;
      // Only the migration owner can clear a refusal by quarantining its verified copy.
      const recoveredPaths = new Set(
        configResult.stateMigrationStepReceipts?.flatMap((receipt) =>
          receipt.id === "media-persistence" ? (receipt.recoveredAgentDatabasePaths ?? []) : [],
        ),
      );
      const sourceIdentities =
        admissionSchemas.agentDatabaseMigrationDiscovery?.discovery.sourceIdentities;
      const agentDatabaseRefusals = (admissionSchemas.agentRefusals ?? []).filter(
        (refusal) =>
          !refusal.paths.every(
            (pathname) =>
              recoveredPaths.has(pathname) ||
              recoveredPaths.has(sourceIdentities?.get(pathname)?.realPath ?? pathname),
          ),
      );
      recordAgentDatabaseAdmissions(agentDatabaseRefusals);
      const { CONFIG_PATH } = await import("../config/config.js");
      const ctx: DoctorHealthFlowContext = {
        runtime: doctorRuntime,
        healthFindings: startupFindings.healthFindings,
        options,
        retirementOnly: writeAuthority?.retirementOnly === true,
        prompter,
        configResult,
        cfg: configResult.cfg,
        cfgForPersistence: structuredClone(configResult.cfg),
        sourceConfigValid: configResult.sourceConfigValid ?? true,
        configPath: configResult.path ?? CONFIG_PATH,
        stateDirExistedAtStart,
        gatewayMaintenanceActive: maintenance !== undefined,
        agentDatabaseRefusals,
        updateWarnings: normalizeUpdatePostInstallDoctorWarnings([
          ...(startupFindings.updateWarnings ?? []),
          ...preparedRuntime.warnings,
        ]),
        preparedAgentCount: Math.max(
          admissionSchemas.agentDatabaseMigrationDiscovery?.configuredAgentDatabaseTargets.length ??
            0,
          admissionSchemas.agentDatabaseMigrationDiscovery?.registeredAgentDatabases.length ?? 0,
        ),
        runWithPluginMetadataSnapshot: configResult.runWithPluginMetadataSnapshot,
        invalidatePluginMetadataSnapshot: configResult.invalidatePluginMetadataSnapshot,
        repairEvidence,
      };
      healthContext = ctx;
      const { runDoctorHealthContributions } = await import("./doctor-health-contributions.js");
      await measure("doctor.contributions", () => runDoctorHealthContributions(ctx));
      if (recordRepairRefusal(ctx)) {
        return undefined;
      }
      if (maintenance) {
        const { validateDoctorExternalConfigForStartup } =
          await import("./doctor-external-config.js");
        if (
          !(await measure("doctor.external-config", () =>
            validateDoctorExternalConfigForStartup(effectiveRuntime),
          ))
        ) {
          exitCode = 1;
          return undefined;
        }
        const { assertDoctorMaintenanceReady } =
          await import("../commands/doctor-maintenance-inspection.js");
        const readiness = await measure("doctor.maintenance-ready", () =>
          assertDoctorMaintenanceReady(
            ctx.cfg,
            process.env,
            effectiveRuntime.log,
            admissionSchemas.agentDatabaseMigrationDiscovery?.discovery.targets ?? [],
          ),
        );
        if (!readiness.schemaPublicationDeferred) {
          sqliteReclamationAgents =
            admissionSchemas.agentDatabaseMigrationDiscovery?.discovery.targets ?? [];
          resumeCapture?.();
          if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_PROXY_ENABLED)) {
            const { initializeDebugProxyCaptureAsync } =
              await import("../proxy-capture/runtime.js");
            await initializeDebugProxyCaptureAsync("cli");
          }
        }
        const { repairGatewayMaintenanceStartupFailures } =
          await import("../infra/gateway-boot-lifecycle.js");
        repairGatewayMaintenanceStartupFailures();
      }
      return ctx;
    };
    let ctx: DoctorHealthFlowContext | undefined;
    let failure: unknown;
    try {
      ctx = await withSqliteSnapshotFailureScope(() =>
        maintenance
          ? maintenance.run(runChecks)
          : withCommandProcessScope(
              () =>
                withSqliteReadOnlyWorkerScope(
                  runChecks,
                  signal ? { signal, deadlineOwnedByCaller: false } : undefined,
                ),
              signal,
            ),
      );
      if (ctx && maintenance && options.repair === true && sqliteNoCowPaths.length > 0) {
        if (
          doctorMode.resolveDoctorRepairMode(options).updateInProgress &&
          !isTruthyEnvValue(process.env[updatePhase.DOCTOR_SQLITE_NOCOW_REPAIR_ENV])
        ) {
          effectiveRuntime.log(
            "SQLite NOCOW repair deferred: the managed updater did not request the store rewrite in this run.",
          );
        } else {
          const activeMaintenance = maintenance;
          await measure("doctor.sqlite-nocow", () =>
            activeMaintenance.repairSqliteNoCow(sqliteNoCowPaths),
          );
        }
      }
      if (ctx && maintenance && ctx.prompter.shouldRepair) {
        const activeMaintenance = maintenance;
        if (
          doctorMode.isDoctorUpdateRepairMode(ctx.prompter.repairMode) &&
          sqliteReclamationAgents
        ) {
          const agents = sqliteReclamationAgents;
          await measure("doctor.sqlite-reclamation", () =>
            activeMaintenance.enableSqliteReclamation(agents),
          );
        }
        await measure("doctor.retained-runtimes", () =>
          activeMaintenance.cleanupRetainedRuntimes(),
        );
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const activeMaintenance = maintenance;
      if (activeMaintenance) {
        const completed = ctx;
        await measure("doctor.maintenance.finish", () =>
          activeMaintenance.finish(
            completed?.cfg,
            completed
              ? async (nextConfig) => {
                  const { writeDoctorGatewayConfig } =
                    await import("./doctor-health-contribution-runners.gateway.js");
                  return writeDoctorGatewayConfig(completed, nextConfig);
                }
              : undefined,
            failure,
          ),
        );
      }
    }
    if (!ctx) {
      showDoctorHealthSummary(healthContext ?? startupFindings);
      return;
    }
    if (recordRepairRefusal(ctx)) {
      return;
    }
    const maintenanceWarnings = maintenance?.warnings ?? [];
    repairEvidence?.remaining("maintenance", maintenanceWarnings);
    const pluginWarnings: string[] = [];
    let pluginLoadFailed = false;
    if (diagnostics.length > 0) {
      const { collectPluginLoadHealthFindings } =
        await import("../commands/doctor-workspace-status.js");
      const findings = collectPluginLoadHealthFindings(diagnostics);
      renderStructuredHealthFindings(ctx, findings);
      pluginWarnings.push(...findings.map((finding) => `${finding.checkId}: ${finding.message}`));
      // Advisory notices, such as open tool schemas, come from plugins that still loaded.
      pluginLoadFailed = findings.some((finding) => finding.severity === "error");
    }
    showDoctorHealthSummary(ctx);
    doctorResult = createDoctorCompletedResult(ctx, maintenance, pluginWarnings);
    if (exitCode === undefined || exitCode === 0) {
      repairEvidence?.complete();
    }
    if (updateResult?.resultPath && doctorResult.status === "advisory") {
      exitCode = UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE;
      return;
    }
    if (pluginLoadFailed) {
      renderOutro("Doctor finished with plugin load errors.");
      if (options.nonInteractive && !updatePhase.isUpdateDoctorLintPass(process.env)) {
        exitCode = 1;
      }
      return;
    }
  } catch (error) {
    const { DoctorHeartbeatMigrationDeferredError } =
      await import("../commands/doctor-heartbeat-run-recovery.js");
    if (
      (!maintenance || error instanceof DoctorHeartbeatMigrationDeferredError) &&
      error instanceof DoctorMaintenanceRefusalError &&
      error.refusal.kind === "deferred" &&
      (doctorMode.isDoctorUpdateRepairMode(doctorMode.resolveDoctorRepairMode(options)) ||
        (error instanceof DoctorHeartbeatMigrationDeferredError &&
          updatePhase.isUpdateDoctorLintPass(process.env)))
    ) {
      showDoctorHealthSummary(healthContext ?? startupFindings);
      writeAuthority?.assertCurrent();
      // Admission restored its service, or heartbeat conversion rolled back
      // before its config writer committed. Pending source data remains intact.
      const { recordDeferredUpdateDoctorWarning, recordUpdateDoctorRefusal } =
        await import("../commands/doctor-update-refusal.js");
      recordUpdateDoctorRefusal(error.message);
      effectiveRuntime.error(error.message);
      doctorResult = { status: "ok", warnings: [error.message], maintenanceRefusal: error.refusal };
      if (!updateResult) {
        await recordDeferredUpdateDoctorWarning(error.message, effectiveRuntime);
      }
      renderOutro("Doctor maintenance deferred; pending repairs remain unchanged.");
      exitCode = 0;
      return;
    }
    const { DoctorStateMigrationRefusalError } =
      await import("../infra/state-migrations.messages.js");
    const refusalWarnings =
      error instanceof DoctorStateMigrationRefusalError
        ? error.failureFacts.map(formatUpdateFailureFact)
        : [];
    if (healthContext && refusalWarnings.length > 0) {
      recordDoctorHealthWarnings(healthContext, [], refusalWarnings, { prepend: true });
    }
    if (error instanceof DoctorStateMigrationRefusalError) {
      const { recordUpdateDoctorRefusal, resolveUpdateDoctorGitRecovery } =
        await import("../commands/doctor-update-refusal.js");
      const recovery = await resolveUpdateDoctorGitRecovery({ root, stateRepaired: true });
      if (recovery) {
        error.message += `\n${recovery.message}`;
        recordUpdateDoctorRefusal(error.message);
      }
    }
    showDoctorHealthSummary(healthContext ?? startupFindings);
    doctorResult = await createDoctorFailureResult(error, refusalWarnings, !healthContext);
    if (maintenance && !(error instanceof DoctorStateMigrationRefusalError)) {
      effectiveRuntime.error(
        "Doctor could not complete maintenance. Check the reported service state and resolve the failure.",
      );
    }
    throw error;
  } finally {
    await measure("doctor.maintenance.release", () => resources.disposeAsync());
    if (updateResult) {
      await publishDoctorUpdateResult({
        updateResult,
        doctorResult,
        healthContext,
        maintenance,
        startupWarnings: startupFindings.updateWarnings,
      });
    }
    // The default runtime exits synchronously; finish native recovery and release
    // maintenance leases before handing it an exit code.
    if (exitCode !== undefined) {
      requestExit(effectiveRuntime, exitCode);
    }
  }

  if (!options.json) {
    startup.showDoctorComplete({ watchExit: options.watchExitAfterComplete === true });
  }
}
