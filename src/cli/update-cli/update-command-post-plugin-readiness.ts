import { UPDATE_POST_CORE_CONVERGENCE_ENV } from "../../commands/doctor/shared/update-phase.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import type { UpdateDoctorLintFinding } from "../../infra/update-doctor-lint-schema.js";
import { parseUpdateDoctorLintReport } from "../../infra/update-doctor-lint.js";
import type { UpdateStepResult } from "../../infra/update-runner-types.js";
import { isConfiguredPluginPathDiagnosticCode } from "../../plugins/discovery-availability.js";
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

function createPostPluginReadinessExecutionFailure(
  pluginUpdate: PostCorePluginUpdateResult,
  reason: string,
): PostCorePluginUpdateResult {
  return {
    ...pluginUpdate,
    status: "error",
    reason: "post-plugin-update-readiness-execution-failed",
    warnings: [
      ...(pluginUpdate.warnings ?? []),
      {
        reason,
        message: "Updated plugin readiness checks could not be completed before restart.",
        guidance: ["Run `openclaw update repair` to retry post-update readiness checks."],
      },
    ],
  };
}

export async function applyPostPluginUpdateReadiness(params: {
  root: string;
  entryPath?: string;
  pluginUpdate: PostCorePluginUpdateResult;
  timeoutMs: number;
  nodeRunner?: string;
}): Promise<PostCorePluginUpdateResult> {
  let entryPath = params.entryPath;
  if (!entryPath) {
    try {
      entryPath = await resolveGatewayInstallEntrypoint(params.root);
    } catch (error) {
      return createPostPluginReadinessExecutionFailure(params.pluginUpdate, String(error));
    }
  }
  if (!entryPath) {
    return createPostPluginReadinessExecutionFailure(
      params.pluginUpdate,
      "Updated OpenClaw entrypoint not found for post-plugin readiness checks",
    );
  }
  const args = [entryPath, "doctor", "--lint", "--json", "--severity-min", "error"];
  const baseEnv = stripGatewayServiceMarkerEnv(disableUpdatedPackageCompileCacheEnv(process.env));
  delete baseEnv[UPDATE_POST_CORE_CONVERGENCE_ENV];
  const startedAt = Date.now();
  const doctorLint: UpdateStepResult = {
    name: "post-plugin-doctor-lint",
    command: args.slice(1).join(" "),
    cwd: params.root,
    durationMs: 0,
    exitCode: null,
    doctorLintFindings: [],
  };
  const pluginUpdate: PostCorePluginUpdateResult = { ...params.pluginUpdate, doctorLint };
  let execution: Awaited<ReturnType<typeof runUtf8CommandWithTimeout>>;
  let report: ReturnType<typeof parseUpdateDoctorLintReport>;
  try {
    execution = await runUtf8CommandWithTimeout(
      [params.nodeRunner ?? resolveNodeRunner(), ...args],
      {
        cwd: params.root,
        timeoutMs: params.timeoutMs,
        input: "",
        maxOutputBytes: 4 * 1024 * 1024,
        outputCapture: "head",
        terminateOnOutputLimit: true,
        baseEnv,
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1",
        },
      },
    );
    doctorLint.exitCode = execution.code;
    doctorLint.termination = execution.termination;
    doctorLint.signal = execution.signal;
    doctorLint.killed = execution.killed;
    doctorLint.outputLimitExceeded = execution.outputLimitExceeded;
    doctorLint.stderrTail = execution.stderr.slice(-2_000);
    report = parseUpdateDoctorLintReport(execution.stdout);
  } catch (error) {
    return createPostPluginReadinessExecutionFailure(pluginUpdate, String(error));
  } finally {
    doctorLint.durationMs = Date.now() - startedAt;
  }
  const completed = execution.termination === "exit" && !execution.outputLimitExceeded;
  doctorLint.doctorLintFindings = report.doctorLintFindings;
  const policyAdvisory =
    execution.code === 1 && completed && report.advisoryOnly && report.checksRun > 0;
  const passed =
    ((execution.code === 0 && completed && report.ok) || policyAdvisory) &&
    report.checksRun > 0 &&
    report.findings.length === 0;
  if (policyAdvisory) {
    doctorLint.advisory = {
      kind: "recoverable-maintenance",
      message: "Doctor security policy findings are advisory during updates.",
    };
  }
  if (report.failureFacts.length) {
    doctorLint.failureFacts = report.failureFacts;
  }
  if (report.warnings.length > 0) {
    pluginUpdate.status = pluginUpdate.status === "error" ? "error" : "warning";
    pluginUpdate.warnings = [
      ...(pluginUpdate.warnings ?? []),
      ...report.warnings.map((finding) => readinessWarning(finding, "doctor-advisory")),
    ];
  }
  if (passed) {
    return pluginUpdate;
  }
  if (report.findings.length === 0) {
    return createPostPluginReadinessExecutionFailure(
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
      ...report.findings.map((finding) => readinessWarning(finding)),
    ],
  };
}
