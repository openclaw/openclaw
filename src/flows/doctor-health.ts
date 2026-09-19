// Doctor health flow renders interactive health check output.
import fs from "node:fs";
import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { stylePromptTitle } from "../../packages/terminal-core/src/prompt-style.js";
import type { DoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import type { DoctorOptions } from "../commands/doctor-prompter.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { formatUpdateDoctorConfigChange } from "../infra/update-doctor-config.js";
import {
  captureUpdateDoctorConfigWrites,
  normalizeUpdatePostInstallDoctorWarnings,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
  UpdateDoctorError,
  type UpdateDoctorWriteAuthority,
  type DoctorConfigCapture,
  type UpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import {
  createUpdateFailureFact,
  normalizeUpdateFailureFacts,
} from "../infra/update-failure-facts.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
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
  const resultPath = process.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim();
  return resultPath
    ? captureUpdateDoctorConfigWrites(
        resolveConfigPath(),
        (capture) =>
          runDoctorHealthFlowWithResult(runtime, options, databasePreflight, {
            resultPath,
            capture,
          }),
        writeAuthority,
      )
    : runDoctorHealthFlowWithResult(runtime, options, databasePreflight);
}

async function runDoctorHealthFlowWithResult(
  runtime: RuntimeEnv | undefined,
  options: DoctorOptions,
  databasePreflight: DoctorDatabasePreflight | undefined,
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
  let healthContext: DoctorHealthFlowContext | undefined;
  let doctorResult: UpdatePostInstallDoctorResult = { status: "error" };
  try {
    const { beginDoctorMaintenance } = await import("../commands/doctor-maintenance.js");
    maintenance = await beginDoctorMaintenance({ options, root, runtime: effectiveRuntime });
    const runChecks = async () => {
      const { createDoctorPrompter } = await import("../commands/doctor-prompter.js");
      const { prepareDoctorDatabasePreflight } =
        await import("../commands/doctor-database-preflight.js");
      const prompter = createDoctorPrompter({ runtime: effectiveRuntime, options });
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
      const schemas = databasePreflight ?? (await prepareDoctorDatabasePreflight());
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
        runtime: effectiveRuntime,
        json: options.json,
      });

      if (maintenance && (options.repair === true || options.yes === true)) {
        const { repairOpenClawStateDatabaseReadabilityForDoctor } =
          await import("../state/openclaw-state-db.js");
        // Restore catalog reads before config discovery; versioned migrations remain in its graph.
        const readability = repairOpenClawStateDatabaseReadabilityForDoctor({ env: process.env });
        if (readability.warnings.length > 0) {
          throw new Error(readability.warnings.join("\n"));
        }
        for (const change of readability.changes) {
          effectiveRuntime.log(change);
        }
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
        agentDatabaseMigrationDiscovery: schemas.agentDatabaseMigrationDiscovery,
        confirm: (p) => prompter.confirm(p),
        runtime: effectiveRuntime,
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
        agentDatabaseRefusals,
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
        return undefined;
      }
      if (options.repair === true || options.yes === true) {
        // Contributions can report optional migration warnings, but repair must not
        // complete while required state still blocks runtime access.
        const { assertSessionStoreMigrationComplete } =
          await import("../config/sessions/startup-migration.js");
        assertSessionStoreMigrationComplete({
          cfg: ctx.cfg,
          env: process.env,
          operation: "doctor",
        });
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
      return ctx;
    };
    const ctx = await (maintenance ? maintenance.run(runChecks) : runChecks());
    if (!ctx) {
      return;
    }
    await maintenance?.finish(ctx.cfg);
    const warnings = normalizeUpdatePostInstallDoctorWarnings([
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
        error instanceof UpdateDoctorError
          ? error.failureFacts
          : error instanceof DoctorStateMigrationRefusalError
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
