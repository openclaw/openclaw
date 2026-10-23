import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { measureGatewayBootstrapStep } from "../cli/startup-trace.js";
import type { BackupSqliteSnapshotFact } from "../commands/backup-resource-inventory.js";
import type { DoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import type { DoctorOptions } from "../commands/doctor-prompter.js";
import * as doctorMode from "../commands/doctor-repair-mode.js";
import * as updatePhase from "../commands/doctor/shared/update-phase.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { withSqliteSnapshotFailureScope } from "../infra/sqlite-error-diagnostics.js";
import { withSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import type { AgentDatabaseMigrationTarget } from "../infra/state-migrations.media-persistence-targets.js";
import { retainUpdateDoctorProcesses } from "../infra/update-doctor-process-custody.js";
import {
  captureUpdateDoctorConfigWrites,
  DoctorMaintenanceRefusalError,
  normalizeUpdatePostInstallDoctorWarnings,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  UpdateDoctorError,
  type UpdateDoctorWriteAuthority,
  type DoctorConfigCapture,
  type UpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import { formatUpdateFailureFact } from "../infra/update-failure-facts-format.js";
import { createUpdateFailureFact } from "../infra/update-failure-facts.js";
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
import { publishDoctorUpdateResult } from "./doctor-health-update-result.js";

/** Runs the full interactive doctor flow against the provided or default runtime. */
export async function runDoctorHealthFlow(
  runtime?: RuntimeEnv,
  options: DoctorOptions = {},
  writeAuthority?: UpdateDoctorWriteAuthority,
  databasePreflight?: DoctorDatabasePreflight,
) {
  const signal = resolveCommandProcessSignal(getAsyncWorkSignal());
  signal?.throwIfAborted();
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
        !writeAuthority?.postCoreSchemaRepair && (options.repair === true || options.yes === true)
          ? resolveUpdateRehearsalRoot(process.env)
          : undefined;
      if (
        process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1" &&
        !writeAuthority?.postCoreSchemaRepair
      ) {
        const { guardUpdateDoctorSchemaUpgrade, rehearseDeferredUpdateDoctorSchema } =
          await import("../commands/doctor-update-schema-guard.js");
        const guarded = await startup.withDoctorProgress(
          "Update schema admission",
          () =>
            guardUpdateDoctorSchemaUpgrade({
              schemas: preparedPreflight,
              runtime,
              json: options.json,
              statePublicationOnly: preCaptureRehearsalRoot !== undefined,
              preserveSourceArtifacts,
            }),
          options.json !== true,
        );
        if (!preCaptureRehearsalRoot) {
          preparedPreflight = guarded ?? preparedPreflight;
        }
        if (!preCaptureRehearsalRoot && preparedPreflight?.updateSchemaRehearsal) {
          const rehearsal = preparedPreflight;
          await startup.withDoctorProgress(
            "Update schema rehearsal",
            () =>
              rehearseDeferredUpdateDoctorSchema(rehearsal, runtime, options.fullIntegrityCheck),
            options.json !== true,
          );
          return;
        }
      }
      const resultPath = process.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim();
      return withPluginLoadDiagnostics((diagnostics) => {
        const runDoctor = (capture?: DoctorConfigCapture) =>
          runDoctorHealthFlowWithResult(
            (selectedRuntime, code) => {
              requestedExit = () => startup.exitDoctorHealthFlow(selectedRuntime, code);
            },
            runtime,
            options,
            preparedPreflight,
            diagnostics,
            resultPath && capture ? { resultPath, capture } : undefined,
            writeAuthority,
            resumeCapture,
            preCaptureRehearsalRoot,
          );
        return resultPath
          ? captureUpdateDoctorConfigWrites(resolveConfigPath(), runDoctor, writeAuthority)
          : runDoctor();
      });
    });
  const { withPluginGenerationSourceCustody } =
    await import("../plugins/plugin-generation-source-lookup.js");
  await withPluginGenerationSourceCustody(() =>
    custody ? withCommandProcessScope(run, undefined, custody) : run(),
  );
  signal?.throwIfAborted();
  requestedExit?.();
}

async function runDoctorHealthFlowWithResult(
  requestExit: (runtime: RuntimeEnv, code: number) => void,
  runtime: RuntimeEnv | undefined,
  options: DoctorOptions,
  databasePreflight: DoctorDatabasePreflight | undefined,
  diagnostics: readonly PluginDiagnostic[],
  updateResult?: { resultPath: string; capture: DoctorConfigCapture },
  writeAuthority?: UpdateDoctorWriteAuthority,
  resumeCapture?: () => void,
  preCaptureRehearsalRoot?: string,
) {
  const signal = resolveCommandProcessSignal(getAsyncWorkSignal());
  const measure = <T>(name: string, run: () => T | Promise<T>) =>
    startup.withDoctorProgress(
      name.replace(/^doctor\./, "").replaceAll(/[.-]/g, " "),
      () => measureGatewayBootstrapStep(name, run),
      options.json !== true,
    );
  const { effectiveRuntime, repairRuntime, stateDirExistedAtStart, root } = await measure(
    "doctor.startup",
    () => startup.prepareDoctorHealthFlow(runtime, options, startup.showDoctorIntro),
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
  const { buffer: startupFindings, reportFindings } =
    createDoctorHealthFindingBuffer(effectiveRuntime);
  let preparedArchiveDiscovery: DoctorDatabasePreflight["agentDatabaseMigrationDiscovery"];
  let doctorResult: UpdatePostInstallDoctorResult = { status: "error" };
  const recordConfigWriteRefusal = (ctx: DoctorHealthFlowContext): boolean => {
    const refusal = startup.showDoctorConfigWriteRefusal(ctx);
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
        outro: startup.showDoctorOutro,
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
    if (options.repair === true || options.yes === true || interactiveRepair) {
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
        databaseGenerations: writeAuthority?.databaseGenerations,
        databasePluginOwners: writeAuthority?.databasePluginOwners,
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
          outro: startup.showDoctorOutro,
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

      if (maintenance && (options.repair === true || options.yes === true)) {
        const repairedState = await measure("doctor.state-database-repair", () =>
          startup.repairDoctorStateDatabase(
            effectiveRuntime,
            options.fullIntegrityCheck ? "full" : "quick",
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
      );
      schemas = preparedRuntime.schemas;
      sqliteNoCowPaths = preparedRuntime.nocowPaths;

      const discovery = schemas.agentDatabaseMigrationDiscovery;
      if (discovery && discovery.stateDir === preparedArchiveDiscovery?.stateDir) {
        discovery.preparedTranscriptArchives = preparedArchiveDiscovery?.preparedTranscriptArchives;
      }
      const { loadAndMaybeMigrateDoctorConfig } = await import("../commands/doctor-config-flow.js");
      const configResult = await measure("doctor.config-flow", () =>
        loadAndMaybeMigrateDoctorConfig({
          options,
          retiredStateAdmitted: true,
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
      };
      healthContext = ctx;
      const { runDoctorHealthContributions } = await import("./doctor-health-contributions.js");
      await measure("doctor.contributions", () => runDoctorHealthContributions(ctx));
      if (recordConfigWriteRefusal(ctx)) {
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
    if (recordConfigWriteRefusal(ctx)) {
      return;
    }
    const pluginWarnings: string[] = [];
    if (diagnostics.length > 0) {
      const { collectPluginLoadHealthFindings } =
        await import("../commands/doctor-workspace-status.js");
      const findings = collectPluginLoadHealthFindings(diagnostics);
      renderStructuredHealthFindings(ctx, findings);
      pluginWarnings.push(...findings.map((finding) => `${finding.checkId}: ${finding.message}`));
    }
    showDoctorHealthSummary(ctx);
    const warnings = normalizeUpdatePostInstallDoctorWarnings([
      ...pluginWarnings,
      ...(ctx.configResult.warnings ?? []),
      ...(maintenance?.warnings ?? []),
      ...(ctx.configResult.stateMigrationStepReceipts ?? []).flatMap((receipt) =>
        receipt.outcome === "warning" ||
        receipt.outcome === "skipped" ||
        receipt.outcome === "deferred"
          ? receipt.warnings
          : [],
      ),
      ...(ctx.postInstallDoctorResult?.warnings ?? []),
    ]);
    doctorResult = {
      ...(ctx.postInstallDoctorResult ?? { status: "ok" }),
      ...(warnings.length ? { warnings } : {}),
      ...(maintenance?.failureFacts?.length
        ? {
            failureFacts: [
              ...maintenance.failureFacts,
              ...(ctx.postInstallDoctorResult?.failureFacts ?? []),
            ],
          }
        : {}),
    };
    if (updateResult && doctorResult.status === "advisory") {
      exitCode = UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE;
      return;
    }
    if (pluginWarnings.length > 0) {
      startup.showDoctorOutro("Doctor finished with plugin load errors.");
      if (options.nonInteractive && !updatePhase.isUpdateDoctorLintPass(process.env)) {
        exitCode = 1;
      }
      return;
    }
  } catch (error) {
    if (
      !maintenance &&
      error instanceof DoctorMaintenanceRefusalError &&
      error.refusal.kind === "deferred" &&
      doctorMode.isDoctorUpdateRepairMode(doctorMode.resolveDoctorRepairMode(options))
    ) {
      showDoctorHealthSummary(healthContext ?? startupFindings);
      writeAuthority?.assertCurrent();
      // Admission restored its service before refusing; no migration work has started.
      const { recordUpdateDoctorRefusal } = await import("../commands/doctor-update-refusal.js");
      recordUpdateDoctorRefusal(error.message);
      effectiveRuntime.error(error.message);
      doctorResult = { status: "ok", warnings: [error.message], maintenanceRefusal: error.refusal };
      const runId = process.env.OPENCLAW_UPDATE_RUN_ID?.trim();
      if (!updateResult && runId) {
        try {
          const { recordUpdateRunStep } = await import("../infra/update-run-ledger.js");
          recordUpdateRunStep(runId, {
            step: "warning:doctor-maintenance",
            status: "completed",
            endedAtMs: Date.now(),
            detail: error.message,
          });
        } catch {
          effectiveRuntime.error(
            "Doctor maintenance warning could not be saved to update history.",
          );
        }
      }
      startup.showDoctorOutro("Doctor maintenance deferred; pending repairs remain unchanged.");
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
    const causes = collectNestedErrorCandidates(error);
    const { classifyDoctorMaintenanceRefusal } =
      await import("../commands/doctor-maintenance-inspection.js");
    const maintenanceRefusal = classifyDoctorMaintenanceRefusal(error);
    const unsafeConfigWrite = causes.find(
      (cause): cause is ConfigWritePostCommitError =>
        cause instanceof ConfigWritePostCommitError && cause.rollbackStatus !== "restored",
    );
    const schemaRefusal = causes.find(
      (cause): cause is UpdateSchemaRefusalError => cause instanceof UpdateSchemaRefusalError,
    );
    const refusalFacts = causes.flatMap((cause) =>
      cause instanceof UpdateDoctorError || cause instanceof DoctorStateMigrationRefusalError
        ? cause.failureFacts
        : [],
    );
    doctorResult = {
      status: "error",
      ...(maintenanceRefusal.kind === "data-at-risk" ? { maintenanceRefusal } : {}),
      ...(!healthContext && refusalWarnings.length > 0 ? { warnings: refusalWarnings } : {}),
      failureFacts:
        !unsafeConfigWrite && !schemaRefusal && refusalFacts.length > 0
          ? refusalFacts
          : [
              createUpdateFailureFact({
                check: unsafeConfigWrite
                  ? "config-write"
                  : schemaRefusal
                    ? "database-schema-preflight"
                    : "doctor",
                code: unsafeConfigWrite
                  ? "rollback-state-unverified"
                  : (schemaRefusal?.code ?? "doctor-failed"),
                message: unsafeConfigWrite
                  ? `${unsafeConfigWrite.publication} config publication; rollback ${unsafeConfigWrite.rollbackStatus}. ${unsafeConfigWrite.message}`
                  : (schemaRefusal?.message ??
                    (error instanceof Error ? error.message : String(error))),
              }),
            ],
    };
    if (maintenance && !(error instanceof DoctorStateMigrationRefusalError)) {
      effectiveRuntime.error(
        "Doctor could not complete maintenance. Check the reported service state and resolve the failure.",
      );
    }
    throw error;
  } finally {
    const startupWarnings = startupFindings.updateWarnings;
    await measure("doctor.maintenance.release", () => resources.disposeAsync());
    if (updateResult) {
      await publishDoctorUpdateResult({
        updateResult,
        doctorResult,
        healthContext,
        maintenance,
        startupWarnings,
      });
    }
    // The default runtime exits synchronously; finish native recovery and release
    // maintenance leases before handing it an exit code.
    if (exitCode !== undefined) {
      requestExit(effectiveRuntime, exitCode);
    }
  }

  startup.showDoctorOutro("Doctor complete.");
}
