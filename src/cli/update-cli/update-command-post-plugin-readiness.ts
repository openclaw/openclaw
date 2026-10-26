import { resolveOpenClawCliInvocation } from "../../../cli-invocation.mjs";
import { UPDATE_POST_CORE_CONVERGENCE_ENV } from "../../commands/doctor/shared/update-phase.js";
import { resolveStateDir } from "../../config/paths.js";
import type { UpdateDoctorLintFinding } from "../../infra/update-doctor-lint-schema.js";
import { parseUpdateDoctorLintReport } from "../../infra/update-doctor-lint.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { redactSupportString } from "../../logging/diagnostic-support-redaction.js";
import { isConfiguredPluginPathDiagnosticCode } from "../../plugins/discovery-availability.js";
import { formatCommandOutput, formatCommandResult } from "../../process/command-error.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
  readCommandProcessFailure,
} from "../../process/exec-result.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { resolveNodeRunner } from "./shared.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
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

export async function applyPostPluginUpdateReadiness(params: {
  root: string;
  entryPath: string;
  pluginUpdate: PostCorePluginUpdateResult;
  timeoutMs: number;
  nodeRunner?: string;
  includeOptionalInspections?: boolean;
}): Promise<PostCorePluginUpdateResult> {
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
  const startedAt = Date.now();
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
    const invocation = resolveOpenClawCliInvocation({
      execPath: params.nodeRunner ?? resolveNodeRunner(),
      entryPath: params.entryPath,
      execArgv: [],
      args,
    });
    execution = await runUtf8CommandWithTimeout([invocation.command, ...invocation.args], {
      cwd: params.root,
      timeoutMs: params.timeoutMs,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
      input: "",
      maxOutputBytes: 4 * 1024 * 1024,
      outputCapture: "head",
      terminateOnOutputLimit: true,
      baseEnv,
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1",
      },
    });
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
