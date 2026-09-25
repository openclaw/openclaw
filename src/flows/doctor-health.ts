// Doctor health flow renders interactive health check output.
import fs from "node:fs";
import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { stylePromptTitle } from "../../packages/terminal-core/src/prompt-style.js";
import type { DoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import type { DoctorOptions } from "../commands/doctor-prompter.js";
import {
  isDoctorUpdateRepairMode,
  resolveDoctorRepairMode,
} from "../commands/doctor-repair-mode.js";
import { isUpdateDoctorLintPass } from "../commands/doctor/shared/update-phase.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { formatUpdateDoctorConfigChange } from "../infra/update-doctor-config.js";
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
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withPluginLoadDiagnostics } from "../plugins/load-diagnostics.js";
import type { PluginDiagnostic } from "../plugins/manifest-types.js";
import { createNonExitingRuntime, type RuntimeEnv } from "../runtime.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { UpdateSchemaRefusalError } from "../state/openclaw-update-schema-refusal.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";

// Interactive doctor entrypoint; lazy imports keep normal CLI startup light.
const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);

const loadConfigModule = createLazyRuntimeModule(() => import("../config/config.js"));

function stateDirectoryExistsAtDoctorStart(): boolean {
  try {
    return fs.statSync(resolveStateDir()).isDirectory();
  } catch {
    return false;
  }
}

/** Runs the full interactive doctor flow against the provided or default runtime. */
export async function runDoctorHealthFlow(
  runtime?: RuntimeEnv,
  options: DoctorOptions = {},
  writeAuthority?: UpdateDoctorWriteAuthority,
  databasePreflight?: DoctorDatabasePreflight,
) {
  let preparedPreflight = databasePreflight;
  if (process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1" && !writeAuthority?.postCoreSchemaRepair) {
    const { guardUpdateDoctorSchemaUpgrade, rehearseDeferredUpdateDoctorSchema } =
      await import("../commands/doctor-update-schema-guard.js");
    preparedPreflight =
      (await guardUpdateDoctorSchemaUpgrade({
        schemas: preparedPreflight,
        runtime,
        json: options.json,
      })) ?? preparedPreflight;
    if (preparedPreflight?.updateSchemaRehearsal) {
      await rehearseDeferredUpdateDoctorSchema(preparedPreflight, runtime);
      return;
    }
  }
  const resultPath = process.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim();
  return withPluginLoadDiagnostics((diagnostics) =>
    resultPath
      ? captureUpdateDoctorConfigWrites(
          resolveConfigPath(),
          (capture) =>
            runDoctorHealthFlowWithResult(
              runtime,
              options,
              preparedPreflight,
              diagnostics,
              { resultPath, capture },
              writeAuthority,
            ),
          writeAuthority,
        )
      : runDoctorHealthFlowWithResult(
          runtime,
          options,
          preparedPreflight,
          diagnostics,
          undefined,
          writeAuthority,
        ),
  );
}

async function runDoctorHealthFlowWithResult(
  runtime: RuntimeEnv | undefined,
  options: DoctorOptions,
  databasePreflight: DoctorDatabasePreflight | undefined,
  diagnostics: readonly PluginDiagnostic[],
  updateResult?: { resultPath: string; capture: DoctorConfigCapture },
  writeAuthority?: UpdateDoctorWriteAuthority,
) {
  const effectiveRuntime = runtime ?? (await import("../runtime.js")).defaultRuntime;
  const repairRuntime: RuntimeEnv = {
    ...effectiveRuntime,
    exit: createNonExitingRuntime().exit,
  };
  // Config loading can initialize SQLite-backed state before integrity runs.
  // Preserve the entry fact so doctor can report that automatic initialization.
  const stateDirExistedAtStart = stateDirectoryExistsAtDoctorStart();
  intro("OpenClaw doctor");

  const { resolveOpenClawPackageRoot } = await import("../infra/openclaw-root.js");
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });

  if (options.repair === true || options.yes === true || options.generateGatewayToken === true) {
    const { assertConfigWriteAllowedInCurrentMode } =
      await import("../config/config-write-guard.js");
    assertConfigWriteAllowedInCurrentMode();
  }
  let maintenance: Awaited<
    ReturnType<typeof import("../commands/doctor-maintenance.js").beginDoctorMaintenance>
  >;
  let exitCode: number | undefined;
  let healthContext: DoctorHealthFlowContext | undefined;
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
    const { beginDoctorMaintenance } = await import("../commands/doctor-maintenance.js");
    maintenance = await beginDoctorMaintenance({
      options,
      root,
      runtime: repairRuntime,
      assertCurrent: writeAuthority?.assertCurrent,
    });
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
      // Explicit repair never offers an update. Acquire its owners before any
      // snapshot; diagnostic Doctor still checks state before update admission.
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
          : await prepareDoctorDatabasePreflight();
      const { recordAgentDatabaseAdmissions } =
        await import("../state/agent-database-admission.js");
      // Repair owns fresh file decisions until its migration graph finishes.
      if (options.repair !== true && options.yes !== true) {
        recordAgentDatabaseAdmissions(schemas.agentRefusals ?? []);
      }
      const { guardUpdateDoctorSchemaUpgrade } =
        await import("../commands/doctor-update-schema-guard.js");
      await guardUpdateDoctorSchemaUpgrade({
        schemas,
        runtime: doctorRuntime,
        json: options.json,
        postCoreSchemaRepair: writeAuthority?.postCoreSchemaRepair,
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
      }

      const { repairDoctorAgentDeletionJournal } =
        await import("../commands/doctor-agent-deletion-journal.js");
      const deletionJournal = await repairDoctorAgentDeletionJournal({
        preflight: schemas,
        shouldRepair: prompter.shouldRepair,
        env: process.env,
      });
      for (const message of deletionJournal.changes) {
        effectiveRuntime.log(message);
      }
      for (const message of deletionJournal.warnings) {
        effectiveRuntime.log(message);
      }

      // Keep side-effect-heavy legacy checks before structured contributions until fully migrated.
      const { maybeRepairUiProtocolFreshness } = await import("../commands/doctor-ui.js");
      const { noteSourceInstallIssues } = await import("../commands/doctor-install.js");
      const { noteStalePluginRuntimeSymlinks } =
        await import("../commands/doctor/shared/plugin-runtime-symlinks.js");
      const { noteStartupOptimizationHints } = await import("../commands/doctor-platform-notes.js");
      await maybeRepairUiProtocolFreshness(doctorRuntime, prompter);
      noteSourceInstallIssues(root);
      await noteStalePluginRuntimeSymlinks(root);
      noteStartupOptimizationHints();

      const { loadAndMaybeMigrateDoctorConfig } = await import("../commands/doctor-config-flow.js");
      const configResult = await loadAndMaybeMigrateDoctorConfig({
        options,
        agentDatabaseMigrationDiscovery: schemas.agentDatabaseMigrationDiscovery,
        confirm: (p) => prompter.confirm(p),
        runtime: doctorRuntime,
        prompter,
      });
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
      const { CONFIG_PATH } = await loadConfigModule();
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
      await runDoctorHealthContributions(ctx);
      if (recordConfigWriteRefusal(ctx)) {
        return undefined;
      }
      if (options.repair === true || options.yes === true) {
        const { assertDoctorMaintenanceReady } =
          await import("../commands/doctor-maintenance-inspection.js");
        await assertDoctorMaintenanceReady(ctx.cfg, process.env, effectiveRuntime.log);
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
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (maintenance) {
        const completed = ctx;
        await maintenance.finish(
          completed?.cfg,
          completed
            ? async (nextConfig) => {
                const { writeDoctorGatewayConfig } =
                  await import("./doctor-health-contribution-runners.gateway.js");
                return writeDoctorGatewayConfig(completed, nextConfig);
              }
            : undefined,
          failure,
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
    const maintenanceRefusal =
      causes.find(
        (cause): cause is DoctorMaintenanceRefusalError =>
          cause instanceof DoctorMaintenanceRefusalError && cause.refusal.kind === "data-at-risk",
      )?.refusal ?? classifyDoctorMaintenanceRefusal(error);
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
    if (maintenance) {
      if (!(error instanceof DoctorStateMigrationRefusalError)) {
        effectiveRuntime.error(
          "Doctor could not complete maintenance. Check the reported service state and resolve the failure.",
        );
      }
    }
    throw error;
  } finally {
    try {
      await maintenance?.release();
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
          ...contributionWarnings.slice(deferredCount),
        ]);
        await writeUpdatePostInstallDoctorResult({
          resultPath: updateResult.resultPath,
          result: {
            ...doctorResult,
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
      effectiveRuntime.exit(exitCode);
    }
  }

  outro("Doctor complete.");
}
