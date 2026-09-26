// Runs post-plugin convergence checks without retaining pre-update plugin modules.
import os from "node:os";
import path from "node:path";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV,
  UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV,
  UPDATE_POST_CORE_CONVERGENCE_ENV,
} from "../../commands/doctor/shared/update-phase.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveConfigPath, resolveStateDir } from "../../config/paths.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveAggregateSqliteInspectionTimeoutMs } from "../../infra/sqlite-readonly-worker.js";
import { collectStateDatabasePaths } from "../../infra/update-candidate-state.js";
import { readUpdateStateDatabaseSizes } from "../../infra/update-candidate-state.sizes.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import type { UpdateDatabaseBackup } from "../../infra/update-database-backup.js";
import { hasDeferredUpdateModelRetirement } from "../../infra/update-deferred-model-retirement.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  DoctorMaintenanceRefusalError,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  UpdateDoctorError,
  type UpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import {
  createUpdateFailureFact,
  normalizeUpdateFailureFacts,
  parseConfigFailureFacts,
  type UpdateFailureFact,
} from "../../infra/update-failure-facts.js";
import { POST_CORE_UPDATE_ENV } from "../../infra/update-post-core-context.js";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import { buildUpdateDoctorEnv } from "../../infra/update-runner-doctor.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import {
  redactPublicSupportDiagnosticLine,
  redactSupportString,
} from "../../logging/diagnostic-support-redaction.js";
import { formatCommandOutput } from "../../process/command-error.js";
import {
  CommandProcessCleanupError,
  createSanitizedCommandError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import { isPlainCommandExitFailure, runExec, type RunExecOptions } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { truncateUtf8Prefix, truncateUtf8Suffix } from "../../utils/utf8-truncate.js";
import { parseUpdateTimeoutMs, resolveNodeRunner, type UpdateCommandOptions } from "./shared.js";
import { createUpdateCommandAuthority } from "./update-command-authority.js";
import { readUpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import { recordUpdateDatabaseWrites } from "./update-command-database-receipts.js";
import {
  assertUpdateDoctorChildSucceeded,
  inspectUpdateDoctorChildSupport,
  withUpdateDoctorChild,
} from "./update-command-doctor-child.js";
import type { PluginUpdateWarning } from "./update-command-plugins-internals.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import { applyPostPluginUpdateReadiness } from "./update-command-post-plugin-readiness.js";
import {
  applyPostPluginConfigValidation,
  POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON,
  POST_PLUGIN_CONFIG_VALIDATION_EXECUTION_FAILED_REASON,
  type PostPluginConfigValidation,
} from "./update-command-post-plugin-validation.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import {
  disableUpdatedPackageCompileCacheEnv,
  stripGatewayServiceMarkerEnv,
  withUpdateEnv,
} from "./update-command-service-env.js";
import { captureUpdateFinalizationDoctorOutput } from "./update-finalization-output.js";

type UpdateDoctorPhase = "pre-plugin" | "post-plugin";

export async function withPrePluginUpdateDoctorEnv<T>(run: () => Promise<T>): Promise<T> {
  return await withUpdateEnv(
    {
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      [UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]: "1",
      [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
      [UPDATE_POST_CORE_CONVERGENCE_ENV]: undefined,
    },
    run,
  );
}

function createPostPluginDoctorExecutionFailure(
  pluginUpdate: PostCorePluginUpdateResult,
  reason: string,
  failureFacts?: UpdateFailureFact[],
): PostCorePluginUpdateResult {
  return {
    ...pluginUpdate,
    status: "error",
    reason: POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON,
    ...(failureFacts?.length ? { failureFacts } : {}),
    warnings: [
      ...(pluginUpdate.warnings ?? []),
      {
        reason,
        message: `Post-update plugin Doctor did not complete: ${reason}`,
        guidance: ["Run `openclaw update repair` to retry post-update plugin repair."],
      },
    ],
  };
}

export async function runUpdateFinalizationDoctorInFreshProcess(params: {
  phase: UpdateDoctorPhase;
  root: string;
  runId?: string;
  opts?: UpdateCommandOptions;
  /** Only local candidate code may supply its known native Doctor contract. */
  doctorConfigWrites?: true;
  databaseBackup?: UpdateDatabaseBackup;
  onDatabaseWriteStep?: (step: UpdateStepResult) => void;
  yes: boolean;
  json: boolean;
  workspaceSuggestions?: boolean;
  timeoutMs?: number;
  nodeRunner?: string;
  entryPath?: string;
  onWarnings?: (warnings: string[]) => void;
  assertCurrent?: () => void;
  /** Propagate a refused child authority to the finalization owner without retrying it. */
  onAuthorityRefused?: () => void;
}): Promise<PluginUpdateWarning | void> {
  const {
    run,
    executorFence,
    runId,
    requester,
    assertCurrent,
    assertRequesterCurrent,
    refuseAuthority,
  } = createUpdateCommandAuthority(params, "Fresh Doctor");
  assertCurrent();
  const entryPath = params.entryPath ?? (await resolveGatewayInstallEntrypoint(params.root));
  if (!entryPath) {
    throw new Error("Updated OpenClaw entrypoint not found for post-plugin doctor");
  }
  assertCurrent();
  const args = [
    entryPath,
    "doctor",
    "--repair",
    "--non-interactive",
    ...(params.workspaceSuggestions ? [] : ["--no-workspace-suggestions"]),
    ...(params.yes ? ["--yes"] : []),
  ];
  const baseEnv = stripGatewayServiceMarkerEnv(disableUpdatedPackageCompileCacheEnv(process.env));
  delete baseEnv[UPDATE_POST_CORE_CONVERGENCE_ENV];
  const doctorResultPath = createUpdatePostInstallDoctorResultPath();
  let doctorResult: UpdatePostInstallDoctorResult | null = null;
  let doctorSettled = true;
  let result: { stdout?: unknown; stderr?: unknown } | undefined;
  assertCurrent();
  try {
    const commandOptions: RunExecOptions = {
      cwd: params.root,
      // Normal updates also carry a default step allowance. Only operator opts
      // may impose a Doctor deadline; standalone finalization supplies its own.
      timeoutMs: params.opts ? parseUpdateTimeoutMs(params.opts.timeout) : params.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      logOutput: false,
      onOutputChunk: captureUpdateFinalizationDoctorOutput(params.phase),
      baseEnv,
      env: {
        [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: doctorResultPath,
        ...((runId ?? params.runId) ? { [UPDATE_RUN_ID_ENV]: runId ?? params.runId } : {}),
        // The outer updater owns service refresh and activation after every
        // migration finishes; a fresh Doctor must not resume its parked service.
        ...buildUpdateDoctorEnv({
          allowGatewayServiceRepair: false,
          allowGatewayActivation: false,
          serviceRepairPolicy: "external",
          deferConfiguredPluginInstallRepair: true,
        }),
        ...(params.phase === "post-plugin" ? { [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1" } : {}),
      },
    };
    const workerCommand = [
      params.nodeRunner ?? resolveNodeRunner(),
      path.join(
        params.root,
        "dist",
        runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
      ),
    ];
    const doctorConfigWrites =
      run &&
      (params.doctorConfigWrites ??
        (await inspectUpdateDoctorChildSupport(
          workerCommand,
          {
            cwd: params.root,
            timeoutMs: params.timeoutMs,
            baseEnv,
            env: commandOptions.env,
          },
          assertCurrent,
        )));
    assertCurrent();
    if (doctorConfigWrites && executorFence && runId) {
      const snapshot = await readUpdateConfigSnapshot(resolveConfigPath());
      assertCurrent();
      const child = await withUpdateDoctorChild(
        {
          root: params.root,
          context: {
            runId,
            executorFence,
            requester: requester?.requester,
            assertRequesterCurrent,
          },
          input: {
            configInputHash: snapshot.hash,
            repair: true,
            databaseGenerations:
              params.databaseBackup?.postMigrationGenerations ??
              params.databaseBackup?.sourceGenerations,
            yes: params.yes,
            workspaceSuggestions: params.workspaceSuggestions === true,
            ...(params.phase === "post-plugin" && process.env[POST_CORE_UPDATE_ENV] === "1"
              ? { postCoreSchemaRepair: true as const }
              : {}),
          },
        },
        (runCommand) =>
          runCommand([...workerCommand, "--doctor"], {
            ...commandOptions,
            maxOutputBytes: commandOptions.maxBuffer,
            terminateOnOutputLimit: true,
          }),
      );
      result = child;
      assertUpdateDoctorChildSucceeded(child);
      assertCurrent();
    } else {
      // A valid legacy target contract retains its shipped CLI Doctor. This is
      // capability selection, never recovery from missing or refused authority.
      result = await runExec(params.nodeRunner ?? resolveNodeRunner(), args, commandOptions);
      assertCurrent();
    }
  } catch (error) {
    if (
      hasCommandProcessCleanupError(error) ||
      (isRecord(error) && error.cleanup === "uncertain")
    ) {
      doctorSettled = false;
      throw new CommandProcessCleanupError({ cause: error });
    }
    if (
      collectNestedErrorCandidates(error).some(
        (cause) =>
          cause instanceof UpdateCommandRecoveryPendingError ||
          cause instanceof UpdateRequesterRevokedError,
      )
    ) {
      refuseAuthority(error);
    }
    assertCurrent();
    doctorResult = await consumeUpdatePostInstallDoctorResult(doctorResultPath);
    if (
      doctorResult?.configWriteRefusal?.reason === "authority-check-failed" ||
      doctorResult?.configWriteRefusal?.reason === "requester-revoked"
    ) {
      refuseAuthority(error);
    }
    if (isRecord(error)) {
      result = error;
      // Enabling the existing result channel gives deferred plugin repair its
      // advisory exit code. Convergence below still owns that repair.
      if (
        error.exitCode === UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE &&
        isPlainCommandExitFailure({
          ...error,
          failed: error.failed === true,
          cause: error.cause,
        }) &&
        doctorResult?.status === "advisory"
      ) {
        return;
      }
    }
    const exitCode = isRecord(error) && typeof error.exitCode === "number" ? error.exitCode : null;
    const redaction = { env: process.env, stateDir: resolveStateDir() };
    const failureFacts = doctorResult?.configWriteRefusal
      ? [
          createUpdateFailureFact({
            check: "config-write",
            code: doctorResult.configWriteRefusal.reason,
            message: doctorResult.configWriteRefusal.message,
          }),
        ]
      : doctorResult?.failureFacts?.length
        ? doctorResult.failureFacts
        : [
            createUpdateFailureFact({
              check: "doctor",
              code: "doctor-failed",
              message:
                typeof result?.stderr === "string" && result.stderr.trim()
                  ? result.stderr
                  : error instanceof Error
                    ? error.message
                    : String(error),
            }),
          ];
    const details = (["stderr", "stdout"] as const).flatMap((stream) => {
      const output = result?.[stream];
      if (typeof output !== "string" || !output.trim()) {
        return [];
      }
      // Execa's message starts with full argv. Keep both actual diagnostics before
      // the bounded update handoff, without cutting a credential before redaction.
      const redacted = redactSupportString(output, redaction, {
        maxLength: Number.MAX_SAFE_INTEGER,
      });
      const formatted = formatCommandOutput(redacted, 384);
      let excerpt = formatted;
      if (Buffer.byteLength(redacted) > 384 || Buffer.byteLength(formatted) > 384) {
        const beginning = formatCommandOutput(truncateUtf8Prefix(redacted, 256), 256);
        excerpt = `${truncateUtf8Prefix(beginning, 256)}\n...\n${truncateUtf8Suffix(formatted, 123)}`;
      }
      return excerpt ? [`${stream}: ${excerpt}`] : [];
    });
    const message = details.length
      ? `Updated ${params.phase} Doctor failed:\n${details.join("\n")}`
      : error instanceof Error
        ? error.message
        : String(error);
    if (
      doctorResult?.status === "error" &&
      doctorResult.maintenanceRefusal?.kind === "data-at-risk"
    ) {
      throw new DoctorMaintenanceRefusalError(message, doctorResult.maintenanceRefusal, {
        cause: error,
        failureFacts,
      });
    }
    // Explicit writer/migration refusals and unsettled writers retain their safety decision.
    // An execution failure alone does not establish that installed state is unsafe.
    if (
      params.phase === "post-plugin" &&
      !(isRecord(error) && error.isCanceled === true) &&
      failureFacts.every((fact) => fact.check === "doctor" && fact.code === "doctor-failed")
    ) {
      return {
        reason: "doctor-advisory",
        message: `Post-update plugin Doctor did not complete${exitCode == null ? "" : ` (exit ${exitCode})`}: ${message}`,
        guidance: ["Run `openclaw update repair` to retry post-update plugin repair."],
      };
    }
    throw new UpdateDoctorError(message, failureFacts, { cause: error, exitCode });
  } finally {
    if (doctorSettled) {
      doctorResult ??= await consumeUpdatePostInstallDoctorResult(doctorResultPath);
    }
    if (params.databaseBackup) {
      const step: UpdateStepResult = {
        name: "database migration writes",
        command: "record Doctor database write fingerprints",
        cwd: params.root,
        durationMs: 0,
        exitCode: 0,
      };
      recordUpdateDatabaseWrites(params.databaseBackup, doctorResult?.databaseWrites, step);
      params.onDatabaseWriteStep?.(step);
    }
    if (doctorResult?.warnings?.length) {
      params.onWarnings?.(doctorResult.warnings);
    }
    // Clack writes directly to the child's stdout. Preserve diagnostics on either
    // exit path without letting them share the parent's JSON result stream.
    if (typeof result?.stdout === "string" && result.stdout.trim()) {
      defaultRuntime[params.json ? "error" : "log"](result.stdout.trimEnd());
    }
    if (typeof result?.stderr === "string" && result.stderr.trim()) {
      defaultRuntime.error(result.stderr.trimEnd());
    }
  }
  if (doctorResult?.status === "ok" && doctorResult.maintenanceRefusal) {
    throw new DoctorMaintenanceRefusalError(
      doctorResult.warnings?.[0] ??
        "Doctor maintenance remains pending; run openclaw doctor --fix.",
      doctorResult.maintenanceRefusal,
    );
  }
}

async function validatePostPluginConfigInFreshProcess(params: {
  root: string;
  timeoutMs: number;
  entryPath: string;
  nodeRunner?: string;
}): Promise<PostPluginConfigValidation> {
  try {
    await runExec(
      params.nodeRunner ?? resolveNodeRunner(),
      [params.entryPath, "config", "validate", "--json"],
      {
        cwd: params.root,
        timeoutMs: params.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        logOutput: false,
        baseEnv: stripGatewayServiceMarkerEnv(disableUpdatedPackageCompileCacheEnv(process.env)),
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" },
      },
    );
    return { status: "valid" };
  } catch (error) {
    const result = isRecord(error) ? error : {};
    const cleanupUncertain = result.cleanup === "uncertain" || hasCommandProcessCleanupError(error);
    // The CLI also emits valid:false for runtime exceptions. Only an ordinary
    // completed failure with actual issues establishes invalid authored config.
    const issues =
      !cleanupUncertain &&
      isPlainCommandExitFailure({
        ...result,
        failed: result.failed === true,
        cause: result.cause,
      }) &&
      typeof result.stdout === "string"
        ? parseConfigFailureFacts(result.stdout, process.env)
        : [];
    if (issues.length) {
      return { status: "invalid", failureFacts: issues };
    }
    const summary = [
      createSanitizedCommandError(result).message,
      ...(typeof result.signal === "string" ? [`signal=${result.signal}`] : []),
      ...(cleanupUncertain ? ["cleanup=uncertain"] : []),
    ].join("; ");
    return {
      status: "execution-failed",
      failureFacts: normalizeUpdateFailureFacts([
        {
          check: "config",
          code: POST_PLUGIN_CONFIG_VALIDATION_EXECUTION_FAILED_REASON,
          message: summary,
        },
        ...(["stderr", "stdout"] as const).flatMap((stream) => {
          const output = result[stream];
          if (typeof output !== "string" || !output.trim()) {
            return [];
          }
          // Node may print a location or source frame before the actual error.
          // Extract known public causes before single-line fact normalization loses them.
          const diagnostic = redactPublicSupportDiagnosticLine(output, {
            env: process.env,
            stateDir: resolveStateDir(),
          });
          return [
            {
              check: "config",
              code: "command-failed",
              message: `${stream}: ${diagnostic === "[redacted-diagnostic]" ? output : diagnostic}`,
            },
          ];
        }),
      ]),
    };
  }
}

export async function completePostCorePluginUpdate(params: {
  root: string;
  runId?: string;
  opts?: UpdateCommandOptions;
  doctorConfigWrites?: true;
  databaseBackup?: UpdateDatabaseBackup;
  onDatabaseWriteStep?: (step: UpdateStepResult) => void;
  pluginUpdate: PostCorePluginUpdateResult;
  freshDoctorRequired: boolean;
  yes: boolean;
  json: boolean;
  timeoutMs?: number;
  nodeRunner?: string;
  beforeDoctor?: () => Promise<void>;
  onWarnings?: (warnings: string[]) => void;
  assertCurrent?: () => void;
}): Promise<{
  pluginUpdate: PostCorePluginUpdateResult;
  configSnapshot: ConfigFileSnapshot;
}> {
  // Preserve the first refused assertion; Doctor error handling cannot retry it.
  let authorityFailed = false;
  const assertCurrent = () => {
    try {
      params.assertCurrent?.();
    } catch (error) {
      authorityFailed = true;
      throw error;
    }
  };
  assertCurrent();
  let pluginUpdate = params.pluginUpdate;
  let entryPath: string | undefined;
  let freshConfigValidation: PostPluginConfigValidation | undefined;
  if (pluginUpdate.status !== "error") {
    try {
      entryPath = await resolveGatewayInstallEntrypoint(params.root);
      assertCurrent();
      if (!entryPath) {
        throw new Error("Updated OpenClaw entrypoint not found for post-plugin doctor");
      }
      if (params.freshDoctorRequired || hasDeferredUpdateModelRetirement()) {
        await params.beforeDoctor?.();
        const warning = await runUpdateFinalizationDoctorInFreshProcess({
          ...params,
          assertCurrent,
          onAuthorityRefused: () => {
            authorityFailed = true;
          },
          entryPath,
          phase: "post-plugin",
        });
        if (warning) {
          pluginUpdate = {
            ...pluginUpdate,
            status: "warning",
            reason: POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON,
            warnings: [...(pluginUpdate.warnings ?? []), warning],
          };
        }
      }
    } catch (err) {
      if (
        authorityFailed ||
        hasCommandProcessCleanupError(err) ||
        err instanceof DoctorMaintenanceRefusalError
      ) {
        throw err;
      }
      // Lost updater authority must not become an advisory that starts more children.
      assertCurrent();
      pluginUpdate = createPostPluginDoctorExecutionFailure(
        params.pluginUpdate,
        String(err),
        err instanceof UpdateDoctorError ? err.failureFacts : undefined,
      );
    }
  }

  assertCurrent();
  // The target owns state writes and its version stamp. Read context without
  // migrating target stores or warning about this parent's expected version skew.
  const configSnapshot = await withUpdateEnv({ OPENCLAW_UPDATE_IN_PROGRESS: "0" }, () =>
    readConfigFileSnapshot({ observe: false, suppressFutureVersionWarning: true }),
  );
  assertCurrent();
  if (entryPath) {
    let checkTimeoutMs = params.timeoutMs;
    if (checkTimeoutMs === undefined) {
      // Doctor can grow shared and agent stores. Measure once after its writes settle.
      const env = { ...process.env };
      const databases = await collectStateDatabasePaths(
        { stateDir: resolveStateDir(env), config: configSnapshot.sourceConfig, env },
        { includeUnconfiguredAgents: false },
      );
      assertCurrent();
      checkTimeoutMs = resolveAggregateSqliteInspectionTimeoutMs(
        "post-plugin checks",
        await readUpdateStateDatabaseSizes(
          Array.from(databases.values(), (database) => database.spellings[0]),
          { nodeRunner: process.execPath, sourceEnv: env, stagingRoot: os.tmpdir() },
        ),
      );
    }
    assertCurrent();
    // No authored file is a valid unconfigured install, not an invalid config.
    // Existing files still need the target schema; every install needs readiness.
    freshConfigValidation =
      !configSnapshot.exists && configSnapshot.valid
        ? { status: "valid" }
        : await validatePostPluginConfigInFreshProcess({
            ...params,
            entryPath,
            timeoutMs: checkTimeoutMs,
          });
    assertCurrent();
    if (freshConfigValidation.status === "valid") {
      pluginUpdate = await applyPostPluginUpdateReadiness({
        root: params.root,
        entryPath,
        pluginUpdate,
        timeoutMs: checkTimeoutMs,
        ...(params.nodeRunner ? { nodeRunner: params.nodeRunner } : {}),
      });
    }
  }
  assertCurrent();
  // Strict validity belongs to the target runtime even when no plugin changed.
  // The parent may retain the previous schema; its snapshot is best-effort context.
  if (freshConfigValidation) {
    pluginUpdate = applyPostPluginConfigValidation(pluginUpdate, freshConfigValidation);
  }
  return { pluginUpdate, configSnapshot };
}
