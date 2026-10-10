import {
  UPDATE_IN_PROGRESS_ENV,
  UPDATE_PARENT_RUNS_POST_ACTIVATION_INSPECTIONS_ENV,
  UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV,
  UPDATE_POST_CORE_CONVERGENCE_ENV,
} from "../../commands/doctor/shared/update-phase.js";
import { resolveStateDir } from "../../config/paths.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { resolvePostActivationInspectionCheckIds } from "../../flows/doctor-health-contributions.js";
import { parseUpdateDoctorLintReport } from "../../infra/update-doctor-lint.js";
import { UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV } from "../../infra/update-doctor-result.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { redactSupportString } from "../../logging/diagnostic-support-redaction.js";
import { formatCommandOutput, formatCommandResult } from "../../process/command-error.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveNodeRunner } from "./shared.js";
import {
  disableUpdatedPackageCompileCacheEnv,
  stripGatewayServiceMarkerEnv,
  withOwnedManagedUpdateEnv,
} from "./update-command-service-env.js";

export const POST_ACTIVATION_INSPECTIONS_STEP = "post-activation doctor inspections";

/**
 * Runs the optional Doctor inspections that the update Doctor deferred out of the
 * stopped window. The Gateway is already serving; findings stay advisory.
 */
export async function runPostActivationInspections(params: {
  root: string;
  result: UpdateRunResult;
  timeoutMs?: number;
  nodeRunner?: string;
  ownedManagedUpdateEnv?: NodeJS.ProcessEnv;
}): Promise<UpdateRunResult> {
  const checkIds = await resolvePostActivationInspectionCheckIds();
  const command = `doctor --lint --json --only ${checkIds.join(",")}`;
  const step: UpdateStepResult = {
    name: POST_ACTIVATION_INSPECTIONS_STEP,
    command,
    cwd: params.root,
    durationMs: 0,
    exitCode: null,
  };
  const startedAt = Date.now();
  const incomplete = (reason: string): UpdateRunResult => {
    step.advisory = {
      kind: "recoverable-maintenance",
      message: `Deferred Doctor inspections did not complete after restart (${reason}). Run \`openclaw ${command.replace(" --json", "")}\` to inspect them.`,
    };
    defaultRuntime.error(step.advisory.message);
    return { ...params.result, steps: [...params.result.steps, step] };
  };
  try {
    const entryPath = await resolveGatewayInstallEntrypoint(params.root);
    if (!entryPath) {
      return incomplete("updated OpenClaw entrypoint not found");
    }
    const execution = await withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, () => {
      // An operator lint against the running install, not another update phase.
      const baseEnv = stripGatewayServiceMarkerEnv(
        disableUpdatedPackageCompileCacheEnv(process.env),
      );
      for (const key of [
        UPDATE_IN_PROGRESS_ENV,
        UPDATE_POST_CORE_CONVERGENCE_ENV,
        UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV,
        UPDATE_PARENT_RUNS_POST_ACTIVATION_INSPECTIONS_ENV,
        UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
      ]) {
        delete baseEnv[key];
      }
      return runUtf8CommandWithTimeout(
        [
          params.nodeRunner ?? resolveNodeRunner(),
          entryPath,
          "doctor",
          "--lint",
          "--json",
          "--only",
          checkIds.join(","),
        ],
        {
          cwd: params.root,
          timeoutMs: params.timeoutMs,
          input: "",
          maxOutputBytes: 4 * 1024 * 1024,
          outputCapture: "head",
          terminateOnOutputLimit: true,
          baseEnv,
        },
      );
    });
    step.exitCode = execution.code;
    step.termination = execution.termination;
    step.signal = execution.signal;
    step.killed = execution.killed;
    step.outputLimitExceeded = execution.outputLimitExceeded;
    const stderr = redactSupportString(
      execution.stderr,
      { env: process.env, stateDir: resolveStateDir() },
      { maxLength: Number.MAX_SAFE_INTEGER },
    );
    step.stderrTail = formatCommandOutput(stderr, 2_000);
    // Lint exits 1 when it reports a warning; any other outcome left checks unfinished.
    if (
      (execution.code !== 0 && execution.code !== 1) ||
      execution.termination !== "exit" ||
      execution.outputLimitExceeded
    ) {
      return incomplete(
        formatCommandResult("Doctor lint", {
          ...execution,
          stdout: "",
          stderr: formatCommandOutput(stderr, 384),
        }),
      );
    }
    const report = parseUpdateDoctorLintReport(execution.stdout);
    step.doctorLintFindings = report.doctorLintFindings;
    const warnings = report.doctorLintFindings
      .filter((finding) => finding.severity !== "info")
      .map((finding) => `${finding.checkId}: ${finding.message}`);
    if (warnings.length > 0) {
      step.warnings = warnings;
      step.advisory = {
        kind: "recoverable-maintenance",
        message: `Deferred Doctor inspections reported ${warnings.length} advisory finding${warnings.length === 1 ? "" : "s"} after restart.`,
      };
    }
    return { ...params.result, steps: [...params.result.steps, step] };
  } catch (error) {
    return incomplete(error instanceof Error ? error.message : String(error));
  } finally {
    step.durationMs = Date.now() - startedAt;
  }
}
