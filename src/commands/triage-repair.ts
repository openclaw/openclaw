// One command adapter around the existing bounded repair engine and Doctor oracle.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { recordAgentCleanupFailure } from "../agents/run-cleanup-timeout.js";
import { isNodeRuntime } from "../daemon/runtime-binary.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import type { HealthFinding } from "../flows/health-checks.js";
import {
  installationTargetEnv,
  type InstallationTarget,
} from "../infra/installation-target-context.js";
import type {
  UpdateRepairParams,
  UpdateRepairValidation,
} from "../infra/update-repair-protocol.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import {
  redactSupportString,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import type { TriageUpdateFailure } from "./triage-update.js";

const triageDoctorReportSchema = z.object({
  ok: z.boolean(),
  findings: z.array(
    z.object({ severity: z.enum(["error", "warning", "info"]), message: z.string() }),
  ),
});

function triageCollectionError(error: unknown, redaction: SupportRedactionContext): string {
  const message = error instanceof Error ? error.message : String(error);
  return scrubDoctorErrorMessage(redactSupportString(message, redaction));
}

/** Doctor validation is a repair result, never proof that the requested Gateway started. */
export async function runTriageRepair(params: {
  target: InstallationTarget;
  targetEnv: NodeJS.ProcessEnv;
  findings: readonly HealthFinding[];
  updateFailure?: TriageUpdateFailure;
  installRoot: string;
  authority: { assertCurrent: () => void; signal: AbortSignal };
}) {
  const { target, findings, updateFailure, installRoot, authority } = params;
  const targetEnv = {
    ...params.targetEnv,
    ...installationTargetEnv(target),
    ...buildUpdateDoctorEnv({
      allowGatewayServiceRepair: false,
      allowGatewayActivation: false,
      serviceRepairPolicy: "external",
    }),
  };
  const redaction = { env: targetEnv, stateDir: target.stateDir };
  const isCurrent = () => {
    authority.signal.throwIfAborted();
    authority.assertCurrent();
    return true;
  };
  isCurrent();
  const { runUpdateRepairLoop } = await import("../infra/update-repair-agent.js");
  const failedResult =
    updateFailure && "result" in updateFailure ? updateFailure.result : undefined;
  let pending: Promise<UpdateRepairValidation> | undefined;
  const validate = (signal: AbortSignal): Promise<UpdateRepairValidation> => {
    pending = (async () => {
      try {
        const [{ resolveGatewayInstallEntrypoint }, { runUtf8CommandWithTimeout }] =
          await Promise.all([
            import("../daemon/gateway-entrypoint.js"),
            import("../process/exec.js"),
          ]);
        const entrypoint = await resolveGatewayInstallEntrypoint(installRoot);
        signal.throwIfAborted();
        isCurrent();
        if (!entrypoint) {
          throw new Error("The installed OpenClaw entrypoint is unavailable.");
        }
        // A fresh child reads the repaired installation and can be cancelled without
        // leaving Doctor's temporary process-global state active in this CLI.
        const doctorCommand = await runUtf8CommandWithTimeout(
          [
            isNodeRuntime(process.execPath) ? process.execPath : "node",
            entrypoint,
            "doctor",
            "--lint",
            "--json",
            "--severity-min",
            "error",
          ],
          {
            cwd: installRoot,
            baseEnv: {},
            env: targetEnv,
            input: "",
            signal,
            killProcessTree: true,
            maxOutputBytes: { stdout: 1024 * 1024, stderr: 16 * 1024 },
            terminateOnOutputLimit: true,
          },
        );
        if (doctorCommand.cleanup !== "normal" && doctorCommand.cleanup !== "cooperative") {
          recordAgentCleanupFailure();
          throw Object.assign(new Error("Doctor validation cleanup is uncertain."), {
            cleanup: "uncertain",
          });
        }
        signal.throwIfAborted();
        isCurrent();
        if (doctorCommand.termination !== "exit" || doctorCommand.outputLimitExceeded) {
          throw new Error("Doctor lint did not complete within its execution or output budget.");
        }
        const doctorReport = triageDoctorReportSchema.parse(JSON.parse(doctorCommand.stdout));
        const errors = doctorReport.findings.filter((finding) => finding.severity === "error");
        if (errors.length === 0 && (doctorCommand.code !== 0 || !doctorReport.ok)) {
          throw new Error("Doctor lint failed without reporting an error finding.");
        }
        return {
          ok: errors.length === 0,
          score: errors.length === 0 ? 0 : -errors.length,
          summary:
            errors.length === 0
              ? "Doctor lint reports no errors."
              : `${errors.length} Doctor lint error(s): ${errors
                  .slice(0, 3)
                  .map((finding) =>
                    redactSupportString(finding.message, redaction, { maxLength: 200 }),
                  )
                  .join("; ")}`,
        };
      } catch (error) {
        if (isRecord(error) && (error.cleanup === "uncertain" || error.cleanup === "forced")) {
          recordAgentCleanupFailure();
          throw error;
        }
        signal.throwIfAborted();
        return {
          ok: false,
          // An unavailable oracle must never appear better than known Doctor errors.
          score: Number.MIN_SAFE_INTEGER,
          summary: `Doctor checks unavailable: ${triageCollectionError(error, redaction)}`,
        };
      }
    })();
    return pending;
  };
  try {
    // The engine runs validation under its deadline before selecting inference.
    // Replace operator intent with that observation before any repair prompt.
    const context: UpdateRepairParams["context"] = {
      ...(updateFailure ?? { error: "Operator requested validation and repair." }),
      phase: "verifying",
      beforeVersion: failedResult?.before?.version ?? undefined,
      targetVersion: failedResult?.after?.version ?? undefined,
      symptoms: findings
        .slice(0, 20)
        .map((finding) =>
          redactSupportString(
            `[${finding.severity}] ${finding.checkId}: ${finding.message}`,
            redaction,
            { maxLength: 200 },
          ),
        ),
    };
    return await runUpdateRepairLoop({
      runId: failedResult?.runId,
      target: {
        stateDir: target.stateDir,
        configPath: target.configPath,
        workspaceDir: target.defaultWorkspaceDir,
        installRoot,
      },
      context,
      budget: { maxTurns: 1 },
      signal: authority.signal,
      isCurrent,
      validate: async (signal) => {
        const observed = await validate(signal);
        if (!updateFailure) {
          context.error = observed.summary;
        }
        return observed;
      },
    });
  } finally {
    // The loop cancels promptly; retain exclusion until its read-only child drains.
    await pending?.catch(() => undefined);
  }
}
