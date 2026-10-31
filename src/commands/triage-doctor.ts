import { z } from "zod";
import { resolveOpenClawCliInvocation } from "../../cli-invocation.mjs";
import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import { isNodeRuntime } from "../daemon/runtime-binary.js";
import type { HealthFinding } from "../flows/health-checks.js";
import type { UpdateRepairValidation } from "../infra/update-repair-protocol.js";
import {
  redactSupportString,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";

const triageDoctorReportSchema = z.object({
  ok: z.boolean(),
  findings: z.array(
    z.object({
      checkId: z.string(),
      severity: z.enum(["error", "warning", "info"]),
      message: z.string(),
      fixHint: z.string().optional(),
    }),
  ),
});

async function runTriageDoctor(params: {
  installRoot: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  severityMin: "info" | "error";
  timeoutMs?: number;
}) {
  const { installRoot, env, signal } = params;
  const entrypoint = await resolveGatewayInstallEntrypoint(installRoot);
  signal.throwIfAborted();
  if (!entrypoint) {
    throw new Error("The installed OpenClaw entrypoint is unavailable.");
  }
  // A fresh child reads the repaired installation and can be cancelled without
  // leaving Doctor's temporary process-global state active in this CLI.
  const invocation = resolveOpenClawCliInvocation({
    execPath: isNodeRuntime(process.execPath) ? process.execPath : "node",
    entryPath: entrypoint,
    execArgv: [],
    args: ["doctor", "--lint", "--json", "--severity-min", params.severityMin],
  });
  const doctorCommand = await runUtf8CommandWithTimeout([invocation.command, ...invocation.args], {
    cwd: installRoot,
    baseEnv: {},
    env,
    input: "",
    signal,
    killProcessTree: true,
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
    maxOutputBytes: { stdout: 1024 * 1024, stderr: 16 * 1024 },
    terminateOnOutputLimit: true,
  });
  signal.throwIfAborted();
  if (doctorCommand.termination !== "exit" || doctorCommand.outputLimitExceeded) {
    throw new Error("Doctor lint did not complete within its execution or output budget.");
  }
  const doctorReport = triageDoctorReportSchema.parse(JSON.parse(doctorCommand.stdout));
  return { report: doctorReport, code: doctorCommand.code };
}

export async function collectTriageDoctorFindings(params: {
  installRoot: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): Promise<readonly HealthFinding[]> {
  const { report, code } = await runTriageDoctor({
    ...params,
    severityMin: "info",
    timeoutMs: 30_000,
  });
  if (report.findings.length === 0 && (code !== 0 || !report.ok)) {
    throw new Error("Doctor lint failed without reporting a finding.");
  }
  return report.findings;
}

export async function validateTriageDoctor(params: {
  installRoot: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  redaction: SupportRedactionContext;
}): Promise<UpdateRepairValidation> {
  const { report, code } = await runTriageDoctor({ ...params, severityMin: "error" });
  const errors = report.findings.filter((finding) => finding.severity === "error");
  if (errors.length === 0 && (code !== 0 || !report.ok)) {
    throw new Error("Doctor lint failed without reporting an error finding.");
  }
  const { redaction } = params;
  return {
    ok: errors.length === 0,
    score: errors.length === 0 ? 0 : -errors.length,
    summary:
      errors.length === 0
        ? "Doctor lint reports no errors."
        : `${errors.length} Doctor lint error(s): ${errors
            .slice(0, 3)
            .map((finding) => redactSupportString(finding.message, redaction, { maxLength: 200 }))
            .join("; ")}`,
  };
}
