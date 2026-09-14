// Doctor health flow renders interactive health check output.
import fs from "node:fs";
import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { stylePromptTitle } from "../../packages/terminal-core/src/prompt-style.js";
import type { DoctorOptions } from "../commands/doctor-prompter.js";
import { shouldDeferConfiguredPluginInstallRepair } from "../commands/doctor/shared/update-phase.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import { formatUpdateDoctorConfigChange } from "../infra/update-doctor-config.js";
import {
  captureUpdateDoctorConfigWrites,
  createDeferredConfiguredPluginRepairDoctorResult,
  getUpdateDoctorConfigWriteAuthority,
  normalizeUpdatePostInstallDoctorWarnings,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
  type UpdateDoctorWriteAuthority,
  type DoctorConfigCapture,
  type UpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import {
  createUpdateFailureFact,
  normalizeUpdateFailureFacts,
} from "../infra/update-failure-facts.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";

// Interactive doctor entrypoint; lazy imports keep normal CLI startup light.
const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);

const loadConfigModule = createLazyRuntimeModule(() => import("../config/config.js"));

async function assertDoctorDatabaseSchemasCompatible(scope?: "state") {
  const databasePreflight = await import("../state/openclaw-database-preflight.js");
  const [{ createConfigIO }, targets] = await Promise.all([
    import("../config/io.js"),
    import("../config/sessions/targets.js"),
  ]);
  const snapshot = await createConfigIO({
    env: { ...process.env },
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  const cfg = snapshot.sourceConfig ?? snapshot.config;
  const databaseSchemas = await databasePreflight.preflightOpenClawDatabaseSchemas({
    env: process.env,
    scope,
    configuredAgentDatabaseTargets: (registeredDatabases) =>
      targets.resolveConfiguredAgentDatabaseTargets(cfg, { env: process.env, registeredDatabases }),
    configuredAgentDatabaseCandidatePaths: targets.resolveConfiguredAgentDatabaseCandidatePaths(
      cfg,
      { env: process.env },
    ),
    agentAdmissionConfig: cfg,
  });
  if (databaseSchemas.incompatible.length > 0) {
    throw new databasePreflight.OpenClawDatabaseSchemaPreflightError(databaseSchemas.incompatible, {
      operation: "doctor",
    });
  }
  const unreadableStateDatabase = databaseSchemas.indeterminate.find(
    (database) => database.kind === "state",
  );
  if (unreadableStateDatabase) {
    throw new DoctorUnreadableStateDatabaseError(
      unreadableStateDatabase.path,
      unreadableStateDatabase.reason,
    );
  }
  return databaseSchemas;
}

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
) {
  const resultPath = process.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim();
  return resultPath
    ? captureUpdateDoctorConfigWrites(
        resolveConfigPath(),
        (capture) => runDoctorHealthFlowWithResult(runtime, options, { resultPath, capture }),
        writeAuthority,
      )
    : runDoctorHealthFlowWithResult(runtime, options);
}

async function runDoctorHealthFlowWithResult(
  runtime: RuntimeEnv | undefined,
  options: DoctorOptions,
  updateResult?: { resultPath: string; capture: DoctorConfigCapture },
) {
  const effectiveRuntime = runtime ?? (await import("../runtime.js")).defaultRuntime;
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
  let doctorResult: UpdatePostInstallDoctorResult = { status: "error" };
  try {
    const rehearsalRoot = resolveUpdateRehearsalRoot(process.env);
    if (shouldDeferConfiguredPluginInstallRepair(process.env) && !rehearsalRoot) {
      let sharedSchemaRepaired = false;
      // The shipped post-install IPC/compatibility handoff checks shared content
      // before it can launch the fresh post-core owner. Other deferred calls,
      // including incomplete private rehearsals, do not acquire this authority.
      if (
        updateResult &&
        process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION?.trim() &&
        (options.repair === true || options.yes === true)
      ) {
        const schemas = await assertDoctorDatabaseSchemasCompatible("state");
        if (schemas.pendingMigrations?.some((database) => database.kind === "state")) {
          const { guardUpdateDoctorSchemaUpgrade } =
            await import("../commands/doctor-update-schema-guard.js");
          await guardUpdateDoctorSchemaUpgrade({
            schemas,
            runtime: effectiveRuntime,
            json: options.json,
          });
          const { beginDoctorMaintenance } = await import("../commands/doctor-maintenance.js");
          const assertCurrent =
            getUpdateDoctorConfigWriteAuthority(resolveConfigPath())?.assertCurrent;
          assertCurrent?.();
          maintenance = await beginDoctorMaintenance({
            options,
            root,
            runtime: effectiveRuntime,
            assertCurrent,
          });
          const { runDoctorSharedStateSchemaMigration } =
            await import("../infra/state-migrations.doctor.js");
          const { throwIfDoctorStateMigrationRefused } =
            await import("../infra/state-migrations.messages.js");
          const receipt = await runDoctorSharedStateSchemaMigration({
            env: process.env,
            assertCurrent,
          });
          throwIfDoctorStateMigrationRefused([receipt]);
          if (receipt.warnings.length > 0) {
            throw new Error(receipt.warnings.join("\n"));
          }
          const repairedSchemas = await assertDoctorDatabaseSchemasCompatible("state");
          if (repairedSchemas.pendingMigrations?.some((database) => database.kind === "state")) {
            throw new Error(
              "Shared state schema repair did not complete before post-core handoff.",
            );
          }
          for (const change of receipt.changes) {
            effectiveRuntime.log(change);
          }
          sharedSchemaRepaired = true;
        }
      }
      // Retained plugin records, agent migrations and owner materialization stay
      // deferred. Only independent aliases may change before plugin convergence.
      if (options.repair === true || options.yes === true) {
        const { repairDoctorConfigBeforePluginConvergence } =
          await import("../commands/doctor/shared/automatic-startup-config-repair.js");
        const changes = await repairDoctorConfigBeforePluginConvergence();
        for (const change of changes) {
          effectiveRuntime.log(change);
        }
      }
      const message = sharedSchemaRepaired
        ? "Shared state schema repair completed; plugin-dependent and agent state repair remain deferred until post-core plugin convergence."
        : "Plugin-dependent Doctor repair deferred until post-core plugin convergence; state migrations have not run.";
      effectiveRuntime.log(message);
      doctorResult = createDeferredConfiguredPluginRepairDoctorResult([message]);
      if (updateResult) {
        exitCode = UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE;
      }
      return;
    }
    if (rehearsalRoot) {
      const { createDoctorRehearsalWriteGuard } =
        await import("../commands/doctor/shared/rehearsal-write-scope.js");
      createDoctorRehearsalWriteGuard(process.env)?.();
    }
    const { beginDoctorMaintenance } = await import("../commands/doctor-maintenance.js");
    maintenance = await beginDoctorMaintenance({ options, root, runtime: effectiveRuntime });
    const { createDoctorPrompter } = await import("../commands/doctor-prompter.js");
    const prompter = createDoctorPrompter({ runtime: effectiveRuntime, options });
    // Explicit repair never offers an update. Acquire its owners before any
    // snapshot; diagnostic Doctor still checks state before update admission.
    if (!maintenance) {
      await assertDoctorDatabaseSchemasCompatible("state");
      const { maybeOfferUpdateBeforeDoctor } = await import("../commands/doctor-update.js");
      const offeredUpdate = await maybeOfferUpdateBeforeDoctor({
        runtime: effectiveRuntime,
        options,
        root,
        confirm: (p) => prompter.confirm(p),
        outro,
      });
      if (offeredUpdate.handled) {
        return;
      }
    }
    const schemas = await assertDoctorDatabaseSchemasCompatible();
    const { evaluateAgentDatabaseAdmissions, recordAgentDatabaseAdmissions } =
      await import("../state/agent-database-admission.js");
    // Repair owns fresh file decisions until its migration graph finishes.
    if (options.repair !== true && options.yes !== true) {
      recordAgentDatabaseAdmissions(schemas.agentRefusals ?? []);
    }
    const { guardUpdateDoctorSchemaUpgrade } =
      await import("../commands/doctor-update-schema-guard.js");
    await guardUpdateDoctorSchemaUpgrade({
      schemas,
      runtime: effectiveRuntime,
      json: options.json,
    });

    let migrationPluginsConverged: true | undefined;
    if (prompter.shouldRepair) {
      const { convergeDoctorMigrationPlugins } =
        await import("../commands/doctor/shared/migration-plugin-convergence.js");
      const { createPluginCapabilityConsentPrompter } =
        await import("../wizard/plugin-capability-consent.js");
      const { note } = await import("../../packages/terminal-core/src/note.js");
      const converged = await convergeDoctorMigrationPlugins({
        env: process.env,
        onCapabilityConsent: createPluginCapabilityConsentPrompter({
          note: async (message, title) => note(message, title),
          confirm: (confirmation) =>
            prompter.confirmRuntimeRepair({
              ...confirmation,
              requiresInteractiveConfirmation: true,
            }),
        }),
      });
      migrationPluginsConverged = converged ? true : undefined;
    }

    // Keep side-effect-heavy legacy checks before structured contributions until fully migrated.
    const { maybeRepairUiProtocolFreshness } = await import("../commands/doctor-ui.js");
    const { noteSourceInstallIssues } = await import("../commands/doctor-install.js");
    const { noteStalePluginRuntimeSymlinks } =
      await import("../commands/doctor/shared/plugin-runtime-symlinks.js");
    const { noteStartupOptimizationHints } = await import("../commands/doctor-platform-notes.js");
    await maybeRepairUiProtocolFreshness(effectiveRuntime, prompter);
    noteSourceInstallIssues(root);
    await noteStalePluginRuntimeSymlinks(root);
    noteStartupOptimizationHints();

    const { loadAndMaybeMigrateDoctorConfig } = await import("../commands/doctor-config-flow.js");
    const configResult = await loadAndMaybeMigrateDoctorConfig({
      options,
      ...(migrationPluginsConverged ? { migrationPluginsConverged } : {}),
      confirm: (p) => prompter.confirm(p),
      runtime: effectiveRuntime,
      prompter,
    });
    // Explicit Doctor recovery may have moved a byte-identical misplaced copy aside.
    recordAgentDatabaseAdmissions(await evaluateAgentDatabaseAdmissions(configResult.cfg));
    const { CONFIG_PATH } = await loadConfigModule();
    const ctx: DoctorHealthFlowContext = {
      runtime: effectiveRuntime,
      options,
      prompter,
      configResult,
      cfg: configResult.cfg,
      cfgForPersistence: structuredClone(configResult.cfg),
      sourceConfigValid: configResult.sourceConfigValid ?? true,
      configPath: configResult.path ?? CONFIG_PATH,
      stateDirExistedAtStart,
      gatewayMaintenanceActive: maintenance !== undefined,
      runWithPluginMetadataSnapshot: configResult.runWithPluginMetadataSnapshot,
      invalidatePluginMetadataSnapshot: configResult.invalidatePluginMetadataSnapshot,
    };
    const { runDoctorHealthContributions } = await import("./doctor-health-contributions.js");
    await runDoctorHealthContributions(ctx);
    if (ctx.configWriteRefusal) {
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
      return;
    }
    if (options.repair === true || options.yes === true) {
      // Contributions can report optional migration warnings, but repair must not
      // complete while required state still blocks runtime access.
      const { assertSessionStoreMigrationComplete } =
        await import("../config/sessions/startup-migration.js");
      assertSessionStoreMigrationComplete({ cfg: ctx.cfg, env: process.env, operation: "doctor" });
      const { assertOpenClawDatabasesReady } =
        await import("../state/openclaw-database-preflight.js");
      const { resolveConfiguredAgentDatabaseTargets } =
        await import("../config/sessions/targets.js");
      await assertOpenClawDatabasesReady({
        env: process.env,
        config: ctx.cfg,
        operation: "doctor",
        onDeferredSchemaPublication: (publication) => effectiveRuntime.log(publication.message),
        configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(ctx.cfg, {
          env: process.env,
        }),
      });
      const { assertConfiguredWorkspaceStateReady } =
        await import("../agents/workspace-state-dirs.js");
      await assertConfiguredWorkspaceStateReady({ cfg: ctx.cfg, operation: "doctor" });
      const { assertNoPendingLegacyExecApprovals } =
        await import("../infra/exec-approvals-migration-gate.js");
      assertNoPendingLegacyExecApprovals({ operation: "doctor" });
      const { repairGatewayMaintenanceStartupFailures } =
        await import("../infra/gateway-boot-lifecycle.js");
      repairGatewayMaintenanceStartupFailures();
    }
    await maintenance?.finish(ctx.cfg);
    const warnings = normalizeUpdatePostInstallDoctorWarnings([
      ...(ctx.configResult.stateMigrationStepReceipts ?? []).flatMap((receipt) =>
        receipt.outcome === "warning" ||
        receipt.outcome === "skipped" ||
        receipt.outcome === "deferred"
          ? receipt.warnings
          : [],
      ),
      ...(ctx.postInstallDoctorResult?.warnings ?? []),
      ...(ctx.updateWarnings ?? []),
    ]);
    doctorResult = {
      ...(ctx.postInstallDoctorResult ?? { status: "ok" }),
      ...(warnings.length ? { warnings } : {}),
    };
    if (updateResult && doctorResult.status === "advisory") {
      exitCode = UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE;
      return;
    }
  } catch (error) {
    const { DoctorStateMigrationRefusalError } =
      await import("../infra/state-migrations.messages.js");
    if (error instanceof DoctorStateMigrationRefusalError) {
      const { recordUpdateDoctorRefusal, resolveUpdateDoctorGitRecovery } =
        await import("../commands/doctor-update-refusal.js");
      const recovery = await resolveUpdateDoctorGitRecovery({ root, stateRepaired: true });
      if (recovery) {
        error.message += `\n${recovery.message}`;
        recordUpdateDoctorRefusal(error.message);
      }
    }
    doctorResult = {
      status: "error",
      failureFacts:
        error instanceof DoctorStateMigrationRefusalError
          ? normalizeUpdateFailureFacts(
              error.stepReceipts.flatMap((receipt) =>
                receipt.outcome === "refused" && receipt.refusal
                  ? [
                      {
                        check: receipt.id,
                        code: receipt.refusal.code,
                        message: receipt.refusal.message,
                      },
                    ]
                  : [],
              ),
            )
          : [
              createUpdateFailureFact({
                check: "doctor",
                code: "doctor-failed",
                message: error instanceof Error ? error.message : String(error),
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
        await writeUpdatePostInstallDoctorResult({
          resultPath: updateResult.resultPath,
          result: {
            ...doctorResult,
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
