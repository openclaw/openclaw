import { StringDecoder } from "node:string_decoder";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveOpenClawCliInvocation } from "../../../cli-invocation.mjs";
import { UPDATE_POST_CORE_CONVERGENCE_ENV } from "../../commands/doctor/shared/update-phase.js";
import { resolveStateDir } from "../../config/paths.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import type { UpdateDoctorLintFinding } from "../../infra/update-doctor-lint-schema.js";
import { parseUpdateDoctorLintReport } from "../../infra/update-doctor-lint.js";
import {
  normalizeUpdateFailureFacts,
  parseConfigFailureFacts,
} from "../../infra/update-failure-facts.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import {
  redactPublicSupportDiagnosticLine,
  redactSupportString,
} from "../../logging/diagnostic-support-redaction.js";
import { isConfiguredPluginPathDiagnosticCode } from "../../plugins/discovery-availability.js";
import { formatCommandOutput, formatCommandResult } from "../../process/command-error.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
  readCommandProcessFailure,
  createSanitizedCommandError,
  type SpawnResult,
} from "../../process/exec-result.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { scheduleAbsoluteDeadline } from "../../utils/absolute-deadline.js";
import { resolveNodeRunner } from "./shared.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import {
  applyPostPluginConfigValidation,
  POST_PLUGIN_CONFIG_VALIDATION_EXECUTION_FAILED_REASON,
  type PostPluginConfigValidation,
} from "./update-command-post-plugin-validation.js";
import {
  disableUpdatedPackageCompileCacheEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";

function readinessWarning(
  finding: UpdateDoctorLintFinding,
  reason = finding.checkId,
): NonNullable<PostCorePluginUpdateResult["warnings"]>[number] {
  const pathReason = isConfiguredPluginPathDiagnosticCode(finding.requirement)
    ? finding.requirement
    : undefined;
  return {
    reason: pathReason ?? reason,
    message: finding.message,
    ...(finding.errorCode ? { errorCode: finding.errorCode } : {}),
    guidance: [
      finding.fixHint ??
        `Resolve this finding, then rerun \`openclaw doctor --lint --only ${finding.checkId}\`.`,
    ],
    ...(finding.source
      ? pathReason
        ? { source: finding.source }
        : { pluginId: finding.source }
      : {}),
  };
}

function createPostPluginReadinessExecutionWarning(
  pluginUpdate: PostCorePluginUpdateResult,
  reason: string,
): PostCorePluginUpdateResult {
  const diagnostic = redactSupportString(
    reason,
    { env: process.env, stateDir: resolveStateDir() },
    { maxLength: 500 },
  );
  const warning = {
    reason: "doctor-advisory",
    message: `Updated plugin readiness checks could not be completed before restart. ${diagnostic}`,
    guidance: ["Run `openclaw update repair` to retry post-update readiness checks."],
  };
  if (pluginUpdate.doctorLint) {
    pluginUpdate.doctorLint.advisory = {
      kind: "recoverable-maintenance",
      message: warning.message,
    };
  }
  return {
    ...pluginUpdate,
    status: pluginUpdate.status === "error" ? "error" : "warning",
    reason: pluginUpdate.reason ?? "post-plugin-update-readiness-execution-failed",
    warnings: [...(pluginUpdate.warnings ?? []), warning],
  };
}

function configValidation(
  execution: SpawnResult | undefined,
  error?: unknown,
): PostPluginConfigValidation {
  const cleanupUncertain =
    execution?.cleanup === "uncertain" ||
    (isRecord(error) && error.cleanup === "uncertain") ||
    hasCommandProcessCleanupError(error) ||
    readCommandProcessFailure(error)?.cleanup === "uncertain";
  if (
    !cleanupUncertain &&
    execution?.code === 0 &&
    execution.termination === "exit" &&
    !execution.outputLimitExceeded
  ) {
    return { status: "valid" };
  }
  const issues =
    !cleanupUncertain &&
    execution?.termination === "exit" &&
    !execution.outputLimitExceeded &&
    execution.code !== null
      ? parseConfigFailureFacts(execution.stdout, process.env)
      : [];
  if (issues.length) {
    return { status: "invalid", failureFacts: issues };
  }
  const result = execution
    ? {
        ...execution,
        exitCode: execution.code,
        timedOut: execution.termination === "timeout",
        isMaxBuffer: execution.outputLimitExceeded,
        isTerminated: execution.termination === "signal",
      }
    : isRecord(error)
      ? error
      : {};
  return {
    status: "execution-failed",
    failureFacts: normalizeUpdateFailureFacts([
      {
        check: "config",
        code: POST_PLUGIN_CONFIG_VALIDATION_EXECUTION_FAILED_REASON,
        message: [
          createSanitizedCommandError(result).message,
          ...(typeof result.signal === "string" ? [`signal=${result.signal}`] : []),
          ...(cleanupUncertain ? ["cleanup=uncertain"] : []),
        ].join("; "),
      },
      ...(["stderr", "stdout"] as const).flatMap((stream) => {
        const output = result[stream];
        if (typeof output !== "string" || !output.trim()) {
          return [];
        }
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

export async function applyPostPluginUpdateChecks(params: {
  root: string;
  entryPath: string;
  pluginUpdate: PostCorePluginUpdateResult;
  timeoutMs: number;
  nodeRunner?: string;
  includeOptionalInspections?: boolean;
  candidateRuntime?: boolean;
  skipConfigValidation: boolean;
  assertCurrent?: () => void;
}): Promise<PostCorePluginUpdateResult> {
  let authorityFailure: { error: unknown } | undefined;
  const assertCurrent = () => {
    try {
      params.assertCurrent?.();
    } catch (error) {
      authorityFailure ??= { error };
      throw error;
    }
  };
  const args = [
    "doctor",
    "--lint",
    "--json",
    "--severity-min",
    params.includeOptionalInspections ? "info" : "error",
    ...(params.includeOptionalInspections ? ["--all"] : []),
  ];
  const baseEnv = stripGatewayServiceMarkerEnv(disableUpdatedPackageCompileCacheEnv(process.env));
  delete baseEnv[UPDATE_POST_CORE_CONVERGENCE_ENV];
  let startedAt = Date.now();
  let validated = !params.candidateRuntime && params.skipConfigValidation;
  const doctorLint: UpdateStepResult = {
    name: "post-plugin-doctor-lint",
    command: args.join(" "),
    cwd: params.root,
    durationMs: 0,
    exitCode: null,
    doctorLintFindings: [],
  };
  const pluginUpdate: PostCorePluginUpdateResult = { ...params.pluginUpdate, doctorLint };
  let execution: Awaited<ReturnType<typeof runUtf8CommandWithTimeout>>;
  let executionFailure: string | undefined;
  let report: ReturnType<typeof parseUpdateDoctorLintReport>;
  try {
    const runCheck = async (checkArgs: string[], combined = false): Promise<SpawnResult> => {
      const nodeRunner = params.nodeRunner ?? resolveNodeRunner();
      let command: string[];
      if (combined) {
        command = [
          nodeRunner,
          ...resolveRuntimeWorkerArgv(
            resolveRuntimeWorkerUrl({
              ...runtimeProcessEntrypoints.updateMigratedFinalize,
              root: params.root,
            }),
            nodeRunner,
          ),
          ...checkArgs,
        ];
      } else {
        const invocation = resolveOpenClawCliInvocation({
          execPath: nodeRunner,
          entryPath: params.entryPath,
          execArgv: [],
          args: checkArgs,
        });
        command = [invocation.command, ...invocation.args];
      }
      const controller = new AbortController();
      let deadline = Date.now() + params.timeoutMs;
      let cancelDeadline = combined
        ? scheduleAbsoluteDeadline(deadline, () => controller.abort())
        : undefined;
      let stdoutLine = "";
      const decoder = new StringDecoder("utf8");
      const bytes = { stdout: 0, stderr: 0 };
      try {
        assertCurrent();
        const result = await runUtf8CommandWithTimeout(command, {
          cwd: params.root,
          ...(combined ? { signal: controller.signal } : { timeoutMs: params.timeoutMs }),
          killProcessTree: true,
          requireProcessTreeExtinction: true,
          input: "",
          maxOutputBytes: (combined ? 8 : 4) * 1024 * 1024,
          outputCapture: "head",
          terminateOnOutputLimit: true,
          baseEnv,
          env: {
            OPENCLAW_UPDATE_IN_PROGRESS: validated ? "1" : "0",
            ...(validated ? { [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1" } : {}),
          },
          ...(combined
            ? {
                onOutputChunk: (chunk, stream) => {
                  let phaseBytes = chunk.length;
                  if (!validated && stream === "stdout" && !stdoutLine.includes("\n")) {
                    stdoutLine += decoder.write(chunk);
                    const newline = stdoutLine.indexOf("\n");
                    if (newline !== -1) {
                      let success = false;
                      try {
                        success = JSON.parse(stdoutLine.slice(0, newline)).valid === true;
                      } catch {}
                      if (success && Date.now() < deadline && !controller.signal.aborted) {
                        const remainderBytes = chunk.length - chunk.indexOf(10) - 1;
                        if (bytes.stdout + chunk.length - remainderBytes > 4 * 1024 * 1024) {
                          return false;
                        }
                        assertCurrent();
                        validated = true;
                        bytes.stdout = bytes.stderr = 0;
                        phaseBytes = remainderBytes;
                        startedAt = Date.now();
                        deadline = startedAt + params.timeoutMs;
                        cancelDeadline?.();
                        cancelDeadline = scheduleAbsoluteDeadline(deadline, () =>
                          controller.abort(),
                        );
                      }
                    }
                  }
                  bytes[stream] += phaseBytes;
                  return bytes[stream] <= 4 * 1024 * 1024;
                },
              }
            : {}),
        });
        assertCurrent();
        if (combined && (controller.signal.aborted || Date.now() >= deadline)) {
          result.termination = "timeout";
        }
        return combined && validated
          ? { ...result, stdout: result.stdout.slice(result.stdout.indexOf("\n") + 1) }
          : result;
      } finally {
        cancelDeadline?.();
      }
    };
    if (!params.candidateRuntime && !validated) {
      execution = await runCheck(["config", "validate", "--json"]);
      const validation = configValidation(execution);
      if (validation.status !== "valid") {
        return applyPostPluginConfigValidation(params.pluginUpdate, validation);
      }
      validated = true;
    }
    startedAt = Date.now();
    execution = await runCheck(
      params.candidateRuntime
        ? [
            "--post-plugin-checks",
            ...(params.skipConfigValidation ? ["--skip-config-validation"] : []),
            ...(params.includeOptionalInspections ? ["--include-optional-inspections"] : []),
          ]
        : args,
      params.candidateRuntime,
    );
    if (!validated) {
      return applyPostPluginConfigValidation(
        params.pluginUpdate,
        configValidation(execution.code === 0 ? { ...execution, code: null } : execution),
      );
    }
    if (execution.cleanup === "uncertain") {
      throw new CommandProcessCleanupError();
    }
    doctorLint.exitCode = execution.code;
    doctorLint.termination = execution.termination;
    doctorLint.signal = execution.signal;
    doctorLint.killed = execution.killed;
    doctorLint.outputLimitExceeded = execution.outputLimitExceeded;
    // Redact before bounding diagnostics, and never copy command argv into the warning.
    const stderr = redactSupportString(
      execution.stderr,
      { env: process.env, stateDir: resolveStateDir() },
      { maxLength: Number.MAX_SAFE_INTEGER },
    );
    doctorLint.stderrTail = formatCommandOutput(stderr, 2_000);
    if (execution.code !== 0 || execution.termination !== "exit" || execution.outputLimitExceeded) {
      executionFailure = formatCommandResult("Post-plugin Doctor readiness", {
        ...execution,
        stdout: "",
        stderr: formatCommandOutput(stderr, 384),
      });
    }
    report = parseUpdateDoctorLintReport(execution.stdout);
  } catch (error) {
    if (authorityFailure) {
      throw authorityFailure.error;
    }
    assertCurrent();
    if (!validated) {
      return applyPostPluginConfigValidation(
        params.pluginUpdate,
        configValidation(undefined, error),
      );
    }
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    if (readCommandProcessFailure(error)?.cleanup === "uncertain") {
      throw new CommandProcessCleanupError({ cause: error });
    }
    // A settled lint execution failure is not evidence that installed state is unsafe.
    return createPostPluginReadinessExecutionWarning(
      pluginUpdate,
      executionFailure ?? String(error),
    );
  } finally {
    doctorLint.durationMs = Date.now() - startedAt;
  }
  const completed = execution.termination === "exit" && !execution.outputLimitExceeded;
  doctorLint.doctorLintFindings = report.doctorLintFindings;
  const inspectionAdvisories = params.includeOptionalInspections
    ? report.findings.filter(
        (finding) => finding.severity === "info" || finding.severity === "warning",
      )
    : [];
  const readinessFindings = report.findings.filter(
    (finding) => !inspectionAdvisories.includes(finding),
  );
  const advisoryOnly =
    execution.code === 1 &&
    completed &&
    (report.advisoryOnly || inspectionAdvisories.length > 0) &&
    readinessFindings.length === 0 &&
    report.checksRun > 0;
  const passed =
    ((execution.code === 0 && completed && report.ok) || advisoryOnly) &&
    report.checksRun > 0 &&
    readinessFindings.length === 0;
  if (advisoryOnly) {
    doctorLint.advisory = {
      kind: "recoverable-maintenance",
      message:
        inspectionAdvisories.length > 0
          ? "Doctor inspection findings are advisory during updates."
          : "Doctor security policy findings are advisory during updates.",
    };
  }
  if (report.failureFacts.length) {
    doctorLint.failureFacts = report.failureFacts;
  }
  const warnings = [
    ...report.warnings,
    ...inspectionAdvisories.filter((finding) => finding.severity !== "info"),
  ];
  if (warnings.length > 0) {
    pluginUpdate.status = pluginUpdate.status === "error" ? "error" : "warning";
    pluginUpdate.warnings = [
      ...(pluginUpdate.warnings ?? []),
      ...warnings.map((finding) => readinessWarning(finding, "doctor-advisory")),
    ];
  }
  if (passed) {
    if (params.includeOptionalInspections) {
      doctorLint.deferredInspectionCheckIds = [];
    }
    return pluginUpdate;
  }
  if (readinessFindings.length === 0) {
    return createPostPluginReadinessExecutionWarning(
      pluginUpdate,
      report.checksRun === 0
        ? "Updated Doctor did not run a declared readiness check."
        : "Updated Doctor readiness checks failed without a finding.",
    );
  }
  return {
    ...pluginUpdate,
    status: "error",
    reason: "post-plugin-update-readiness-failed",
    failureFacts: report.failureFacts,
    warnings: [
      ...(pluginUpdate.warnings ?? []),
      ...readinessFindings.map((finding) => readinessWarning(finding)),
    ],
  };
}
