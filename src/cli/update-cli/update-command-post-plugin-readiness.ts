import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { UPDATE_POST_CORE_CONVERGENCE_ENV } from "../../commands/doctor/shared/update-phase.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import {
  parseUpdateDoctorLintReport,
  type UpdateDoctorLintFinding,
} from "../../infra/update-doctor-lint.js";
import { runExec } from "../../process/exec.js";
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
  return {
    reason,
    message: finding.message,
    guidance: [
      finding.fixHint ??
        `Resolve this finding, then rerun \`openclaw doctor --lint --only ${finding.checkId}\`.`,
    ],
    ...(finding.source ? { pluginId: finding.source } : {}),
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
  let stdout: string;
  let executionFailed = false;
  try {
    stdout = (
      await runExec(params.nodeRunner ?? resolveNodeRunner(), args, {
        cwd: params.root,
        timeoutMs: params.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        logOutput: false,
        baseEnv,
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1",
        },
      })
    ).stdout;
  } catch (error) {
    if (!isRecord(error) || typeof error.stdout !== "string") {
      return createPostPluginReadinessExecutionFailure(params.pluginUpdate, String(error));
    }
    executionFailed = true;
    stdout = error.stdout;
  }

  let report: ReturnType<typeof parseUpdateDoctorLintReport>;
  try {
    report = parseUpdateDoctorLintReport(stdout);
  } catch (error) {
    return createPostPluginReadinessExecutionFailure(params.pluginUpdate, String(error));
  }
  const pluginUpdate: PostCorePluginUpdateResult =
    report.warnings.length > 0
      ? {
          ...params.pluginUpdate,
          status: params.pluginUpdate.status === "error" ? "error" : "warning",
          warnings: [
            ...(params.pluginUpdate.warnings ?? []),
            ...report.warnings.map((finding) => readinessWarning(finding, "doctor-advisory")),
          ],
        }
      : params.pluginUpdate;
  if (report.ok && !executionFailed && report.checksRun > 0 && report.findings.length === 0) {
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
    warnings: [
      ...(pluginUpdate.warnings ?? []),
      ...report.findings.map((finding) => readinessWarning(finding)),
    ],
  };
}
