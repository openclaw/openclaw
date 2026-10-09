import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { stylePromptTitle } from "../../packages/terminal-core/src/prompt-style.js";
import { measureGatewayBootstrapStep } from "../cli/startup-trace.js";
import type { BackupSqliteSnapshotFact } from "../commands/backup-resource-inventory.js";
import type { DoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import type { DoctorOptions } from "../commands/doctor-prompter.js";
import {
  isDoctorUpdateRepairMode,
  resolveDoctorRepairMode,
} from "../commands/doctor-repair-mode.js";
import {
  DOCTOR_SQLITE_NOCOW_REPAIR_ENV,
  isUpdateDoctorLintPass,
} from "../commands/doctor/shared/update-phase.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { AgentDatabaseMigrationTarget } from "../infra/state-migrations.media-persistence-targets.js";
import { formatUpdateDoctorConfigChange } from "../infra/update-doctor-config.js";
import { retainUpdateDoctorProcesses } from "../infra/update-doctor-process-custody.js";
import {
  captureUpdateDoctorConfigWrites,
  DoctorMaintenanceRefusalError,
  normalizeUpdatePostInstallDoctorWarnings,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
  UpdateDoctorError,
  type UpdateDoctorWriteAuthority,
  type DoctorConfigCapture,
  type UpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import { formatUpdateFailureFact } from "../infra/update-failure-facts-format.js";
import { createUpdateFailureFact } from "../infra/update-failure-facts.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withPluginLoadDiagnostics } from "../plugins/load-diagnostics.js";
import type { PluginDiagnostic } from "../plugins/manifest-types.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { withDeferredDebugProxyCapture } from "../proxy-capture/runtime-deferral.js";
import type { RuntimeEnv } from "../runtime.js";
import { UpdateSchemaRefusalError } from "../state/openclaw-update-schema-refusal.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";

// Interactive doctor entrypoint; lazy imports keep normal CLI startup light.
const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);

/** Runs the full interactive doctor flow against the provided or default runtime. */
export async function runDoctorHealthFlow(
  runtime?: RuntimeEnv,
  options: DoctorOptions = {},
  writeAuthority?: UpdateDoctorWriteAuthority,
  databasePreflight?: DoctorDatabasePreflight,
) {
  using custody = await retainUpdateDoctorProcesses(
    writeAuthority?.assertCurrent,
    writeAuthority?.commandAuthority,
  );
  let requestedExit: (() => void) | undefined;
  const run = () =>
    withDeferredDebugProxyCapture(async (resumeCapture) => {
      let preparedPreflight = databasePreflight;
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
        const guarded = await guardUpdateDoctorSchemaUpgrade({
          schemas: preparedPreflight,
          runtime,
          json: options.json,
          statePublicationOnly: preCaptureRehearsalRoot !== undefined,
        });
        if (!preCaptureRehearsalRoot) {
          preparedPreflight = guarded ?? preparedPreflight;
        }
        if (!preCaptureRehearsalRoot && preparedPreflight?.updateSchemaRehearsal) {
          await rehearseDeferredUpdateDoctorSchema(preparedPreflight, runtime);
          return;
        }
      }
      const resultPath = process.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim();
      return withPluginLoadDiagnostics((diagnostics) => {
        const runDoctor = (capture?: DoctorConfigCapture) =>
          runDoctorHealthFlowWithResult(
            (selectedRuntime, code) => {
              requestedExit = () => selectedRuntime.exit(code);
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
  const { prepareDoctorHealthFlow } = await import("./doctor-health-startup.js");
  const { effectiveRuntime, repairRuntime, stateDirExistedAtStart, root } =
    await prepareDoctorHealthFlow(runtime, options, intro);
  let maintenance: Awaited<
    ReturnType<typeof import("../commands/doctor-maintenance.js").beginDoctorMaintenance>
  >;
  let sqliteNoCowPaths: string[] = [];
  let sqliteReclamationAgents: readonly AgentDatabaseMigrationTarget[] | undefined;
  let exitCode: number | undefined;
  let healthContext: DoctorHealthFlowContext | undefined;
  let preparedArchiveDiscovery: DoctorDatabasePreflight["agentDatabaseMigrationDiscovery"];
  let doctorResult: UpdatePostInstallDoctorResult = { status: "error" };
  const recordConfigWriteRefusal = (ctx: DoctorHealthFlowContext): boolean => {
    if (!ctx.configWriteRefusal) {
      return false;
    }
    // Config fixes were computed but refused by the writer; the warning above
    // already lists the manual work. This failure outranks a recoverable
    // post-install advisory because the run did not converge.
    outro(
      ctx.configResultWriteCommitted === true
        ? "Doctor finished, but some config fixes were not applied."
        : "Doctor finished, but config fixes were not applied.",
    );
    exitCode = 1;
    doctorResult = {
      status: "error",
      failureFacts: [
        createUpdateFailureFact({
          check: "config-write",
          code: ctx.configWriteRefusal,
          message: "Doctor config fixes were not applied.",
        }),
      ],
    };
    return true;
  };
  try {
    if (options.repair === true || options.yes === true) {
      try {
        const { prepareDoctorDatabasePreflight } =
          await import("../commands/doctor-database-preflight.js");
        preparedArchiveDiscovery = (databasePreflight ?? (await prepareDoctorDatabasePreflight()))
          .agentDatabaseMigrationDiscovery;
        if (preparedArchiveDiscovery) {
          const { prepareCanonicalTranscriptArchiveMigrations } =
            await import("../infra/state-migrations.transcript-directives-archives.js");
          await prepareCanonicalTranscriptArchiveMigrations(preparedArchiveDiscovery);
        }
      } catch (error) {
        // Offline admission still owns repairable schema and discovery failures.
        effectiveRuntime.log(`Archive verification preparation deferred: ${String(error)}`);
      }
      const { waitForCliSignalExit } = await import("../cli/signal-exit-barrier.js");
      // Keep an accepted signal during preparation ahead of service custody.
      await waitForCliSignalExit();
    }
    const [{ beginDoctorMaintenance }, { createDoctorOriginalCaptureHook }] = await Promise.all([
      import("../commands/doctor-maintenance.js"),
      import("../commands/doctor-original-capture-admission.js"),
    ]);
    maintenance = await measureGatewayBootstrapStep("doctor.maintenance.begin", () =>
      beginDoctorMaintenance({
        options,
        root,
        runtime: repairRuntime,
        assertCurrent: writeAuthority?.assertCurrent,
        databaseGenerations: writeAuthority?.databaseGenerations,
        beforeStateMutation: createDoctorOriginalCaptureHook({
          root,
          runtime: repairRuntime,
          writeAuthority,
          rehearsalRoot: preCaptureRehearsalRoot,
          json: options.json,
        }),
      }),
    );
    const runChecks = async () => {
      const doctorRuntime = maintenance ? repairRuntime : effectiveRuntime;
      const { createDoctorPrompter } = await import("../commands/doctor-prompter.js");
      const { prepareDoctorDatabasePreflight } =
        await import("../commands/doctor-database-preflight.js");
      const prompter = createDoctorPrompter({
        runtime: doctorRuntime,
        options,
        signal: maintenance?.signal,
      });
      // Explicit repair never offers an update. Its current-state preflight remains
      // inside maintenance; diagnostic Doctor checks state before update admission.
      if (!maintenance) {
        if (!databasePreflight) {
          await prepareDoctorDatabasePreflight({ scope: "state" });
        }
        const { maybeOfferUpdateBeforeDoctor } = await import("../commands/doctor-update.js");
        const offeredUpdate = await maybeOfferUpdateBeforeDoctor({
          options,
          root,
          confirm: (p) => prompter.confirm(p),
          outro,
        });
        if (offeredUpdate.handled) {
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
          : await measureGatewayBootstrapStep("doctor.database-preflight", () =>
              prepareDoctorDatabasePreflight(),
            );
      const { recordAgentDatabaseAdmissions } =
        await import("../state/agent-database-admission.js");
      // Repair owns fresh file decisions until its migration graph finishes.
      if (options.repair !== true && options.yes !== true) {
        recordAgentDatabaseAdmissions(schemas.agentRefusals ?? []);
      }
      const { guardUpdateDoctorSchemaUpgrade } =
        await import("../commands/doctor-update-schema-guard.js");
      let verifiedSnapshots: readonly BackupSqliteSnapshotFact[] = [];
      await guardUpdateDoctorSchemaUpgrade({
        schemas,
        runtime: doctorRuntime,
        json: options.json,
        postCoreSchemaRepair: writeAuthority?.postCoreSchemaRepair,
        onVerifiedBackup: (snapshots) => {
          verifiedSnapshots = snapshots;
        },
      });

      if (maintenance && (options.repair === true || options.yes === true)) {
        const {
          repairOpenClawStateDatabaseIndexesForDoctor,
          repairOpenClawStateDatabaseReadabilityForDoctor,
        } = await import("../state/openclaw-state-db.js");
        // Restore physical indexes, then legacy catalog readability before config discovery.
        let repairedState = false;
        for (const repair of [
          repairOpenClawStateDatabaseIndexesForDoctor,
          repairOpenClawStateDatabaseReadabilityForDoctor,
        ]) {
          const result = repair({ env: process.env });
          repairedState ||= result.changes.length > 0;
          if (result.warnings.length > 0) {
            throw new Error(result.warnings.join("\n"));
          }
          for (const change of result.changes) {
            effectiveRuntime.log(change);
          }
        }
        if (repairedState) {
          schemas = await prepareDoctorDatabasePreflight();
        }
        const { backupDoctorMigrationDatabases } =
          await import("../commands/doctor-migration-backup.js");
        const { createOpenClawAgentDatabasePathMatcher } =
          await import("../state/openclaw-agent-db.paths.js");
        const { normalizeAgentId } = await import("../routing/session-key.js");
        const samePath = createOpenClawAgentDatabasePathMatcher();
        const discovery = schemas.agentDatabaseMigrationDiscovery?.discovery;
        const databaseTargets = discovery?.targets.filter(
          (database) =>
            !schemas.agentRefusals?.some(
              (refusal) =>
                normalizeAgentId(refusal.agentId) === normalizeAgentId(database.agentId) &&
                refusal.paths.some((pathname) => samePath(pathname, database.path)),
            ) &&
            !schemas.indeterminate.some(
              (failure) =>
                failure.kind === "agent" &&
                (failure.path === database.path ||
                  discovery.sourceIdentities.get(failure.path)?.realPath === database.realPath),
            ),
        );
        const backups = await backupDoctorMigrationDatabases({
          env: process.env,
          databasePaths: databaseTargets?.map((database) => database.path) ?? [],
          agentDatabaseTargets: databaseTargets,
          pendingDatabasePaths: schemas.pendingMigrations?.map((database) => database.path) ?? [],
          verifiedSnapshots,
        });
        for (const message of [...backups.changes, ...backups.warnings]) {
          effectiveRuntime.log(message);
        }
      }

      const { repairDoctorAgentDeletionJournal } =
        await import("../commands/doctor-agent-deletion-journal.js");
      const deletionJournal = await repairDoctorAgentDeletionJournal({
        preflight: schemas,
        shouldRepair: prompter.shouldRepair,
        env: process.env,
      });
      for (const message of [...deletionJournal.changes, ...deletionJournal.warnings]) {
        effectiveRuntime.log(message);
      }
      if (deletionJournal.changes.length > 0) {
        // Quarantine can turn previously active targets into held stores.
        schemas = await prepareDoctorDatabasePreflight();
      }
      const { inspectDoctorSqliteNoCow } = await import("../commands/doctor-sqlite-nocow.js");
      const { resolveOpenClawStateSqlitePath } =
        await import("../state/openclaw-state-db.paths.js");
      const nocow = inspectDoctorSqliteNoCow([
        resolveOpenClawStateSqlitePath(),
        ...(schemas.agentDatabaseMigrationDiscovery?.discovery.targets.map(
          (target) => target.path,
        ) ?? []),
      ]);
      sqliteNoCowPaths = nocow.paths;
      for (const message of nocow.notes) {
        doctorRuntime.log(message);
      }
      // Keep side-effect-heavy legacy checks before structured contributions until fully migrated.
      const { maybeRepairUiProtocolFreshness } = await import("../commands/doctor-ui.js");
      const { noteSourceInstallIssues } = await import("../commands/doctor-install.js");
      const { noteBunCliLauncherIssues } = await import("../commands/doctor-bun-cli-launcher.js");
      const { noteStalePluginRuntimeSymlinks } =
        await import("../commands/doctor/shared/plugin-runtime-symlinks.js");
      const { noteStartupOptimizationHints } = await import("../commands/doctor-platform-notes.js");
      await maybeRepairUiProtocolFreshness(doctorRuntime, prompter);
      await noteSourceInstallIssues(root);
      await noteBunCliLauncherIssues({ root, prompter });
      await noteStalePluginRuntimeSymlinks(root);
      noteStartupOptimizationHints();

      const discovery = schemas.agentDatabaseMigrationDiscovery;
      if (discovery && discovery.stateDir === preparedArchiveDiscovery?.stateDir) {
        discovery.preparedTranscriptArchives = preparedArchiveDiscovery?.preparedTranscriptArchives;
      }
      const { loadAndMaybeMigrateDoctorConfig } = await import("../commands/doctor-config-flow.js");
      const configResult = await measureGatewayBootstrapStep("doctor.config-flow", () =>
        loadAndMaybeMigrateDoctorConfig({
          options,
          agentDatabaseMigrationDiscovery: schemas.agentDatabaseMigrationDiscovery,
          confirm: (p) => prompter.confirm(p),
          runtime: doctorRuntime,
          prompter,
        }),
      );
      // Relocation changes the inspected scope; unchanged fleets retain their prepared facts.
      const admissionSchemas =
        schemas.agentDatabaseMigrationDiscovery &&
        schemas.agentDatabaseMigrationDiscovery.stateDir !== resolveStateDir()
          ? await prepareDoctorDatabasePreflight({ cfg: configResult.cfg })
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
        updateWarnings: deletionJournal.warnings,
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
      await measureGatewayBootstrapStep("doctor.contributions", () =>
        runDoctorHealthContributions(ctx),
      );
      if (recordConfigWriteRefusal(ctx)) {
        return undefined;
      }
      if (options.repair === true || options.yes === true) {
        const { validateDoctorExternalConfigForStartup } =
          await import("./doctor-external-config.js");
        if (!(await validateDoctorExternalConfigForStartup(effectiveRuntime))) {
          exitCode = 1;
          return undefined;
        }
        const { assertDoctorMaintenanceReady } =
          await import("../commands/doctor-maintenance-inspection.js");
        const readiness = await measureGatewayBootstrapStep("doctor.maintenance-ready", () =>
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
      ctx = await (maintenance ? maintenance.run(runChecks) : runChecks());
      if (ctx && maintenance && options.repair === true && sqliteNoCowPaths.length > 0) {
        if (
          resolveDoctorRepairMode(options).updateInProgress &&
          !isTruthyEnvValue(process.env[DOCTOR_SQLITE_NOCOW_REPAIR_ENV])
        ) {
          effectiveRuntime.log(
            "SQLite NOCOW repair deferred: the managed updater did not request the store rewrite in this run.",
          );
        } else {
          await maintenance.repairSqliteNoCow(sqliteNoCowPaths);
        }
      }
      if (ctx && maintenance && ctx.prompter.shouldRepair) {
        if (isDoctorUpdateRepairMode(ctx.prompter.repairMode) && sqliteReclamationAgents) {
          await maintenance.enableSqliteReclamation(sqliteReclamationAgents);
        }
        await maintenance.cleanupRetainedRuntimes();
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const activeMaintenance = maintenance;
      if (activeMaintenance) {
        const completed = ctx;
        await measureGatewayBootstrapStep("doctor.maintenance.finish", () =>
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
    if (!ctx || recordConfigWriteRefusal(ctx)) {
      return;
    }
    const pluginWarnings: string[] = [];
    if (diagnostics.length > 0) {
      const { collectPluginLoadHealthFindings } =
        await import("../commands/doctor-workspace-status.js");
      const { renderStructuredHealthFindings } = await import("./doctor-health-contribution.js");
      const findings = collectPluginLoadHealthFindings(diagnostics);
      renderStructuredHealthFindings(ctx, findings);
      pluginWarnings.push(...findings.map((finding) => `${finding.checkId}: ${finding.message}`));
    }
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
      outro("Doctor finished with plugin load errors.");
      if (options.nonInteractive && !isUpdateDoctorLintPass(process.env)) {
        exitCode = 1;
      }
      return;
    }
  } catch (error) {
    if (
      !maintenance &&
      error instanceof DoctorMaintenanceRefusalError &&
      error.refusal.kind === "deferred" &&
      isDoctorUpdateRepairMode(resolveDoctorRepairMode(options))
    ) {
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
      outro("Doctor maintenance deferred; pending repairs remain unchanged.");
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
      const { recordDoctorHealthWarnings } = await import("./doctor-health-contribution.js");
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
    try {
      await measureGatewayBootstrapStep("doctor.maintenance.release", async () => {
        await maintenance?.release();
      });
    } finally {
      if (updateResult) {
        for (const change of updateResult.capture.configChanges) {
          createSubsystemLogger("update").warn(formatUpdateDoctorConfigChange(change));
        }
        const contributionWarnings = healthContext?.updateWarnings ?? [];
        const deferredCount = healthContext?.updateBudget?.deferred.size ?? 0;
        // Contributions put deferrals first; retain migration advisories before other diagnostics.
        const warnings = normalizeUpdatePostInstallDoctorWarnings([
          ...contributionWarnings.slice(0, deferredCount),
          ...(doctorResult.warnings ?? []),
          ...(maintenance?.warnings ?? []).filter(
            (warning) => !doctorResult.warnings?.includes(warning),
          ),
          ...contributionWarnings.slice(deferredCount),
        ]);
        await writeUpdatePostInstallDoctorResult({
          resultPath: updateResult.resultPath,
          result: {
            ...doctorResult,
            ...(maintenance?.databaseWrites ? { databaseWrites: maintenance.databaseWrites } : {}),
            ...(updateResult.capture.fileWrites
              ? { configFileWrites: updateResult.capture.fileWrites }
              : {}),
            ...(warnings.length ? { warnings } : {}),
            ...(updateResult.capture.configChanges.length
              ? { configChanges: updateResult.capture.configChanges }
              : {}),
            ...(updateResult.capture.configWriteRefusal
              ? { configWriteRefusal: updateResult.capture.configWriteRefusal }
              : {}),
            configHash: updateResult.capture.hash,
            ...(updateResult.capture.inputHash === undefined
              ? {}
              : { configInputHash: updateResult.capture.inputHash }),
          },
        });
      }
    }
    // The default runtime exits synchronously; finish native recovery and release
    // maintenance leases before handing it an exit code.
    if (exitCode !== undefined) {
      requestExit(effectiveRuntime, exitCode);
    }
  }

  outro("Doctor complete.");
}
