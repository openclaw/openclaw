import { z } from "zod";
import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import { isNodeRuntime } from "../daemon/runtime-binary.js";
import type { UpdateRepairValidation } from "../infra/update-repair-protocol.js";
import {
  redactSupportString,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";

const triageDoctorReportSchema = z.object({
  ok: z.boolean(),
  findings: z.array(
    z.object({ severity: z.enum(["error", "warning", "info"]), message: z.string() }),
  ),
});

export async function validateTriageDoctor(params: {
  installRoot: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  redaction: SupportRedactionContext;
}): Promise<UpdateRepairValidation> {
  const { installRoot, env, signal, redaction } = params;
  const entrypoint = await resolveGatewayInstallEntrypoint(installRoot);
  signal.throwIfAborted();
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
      env,
      input: "",
      signal,
      killProcessTree: true,
      maxOutputBytes: { stdout: 1024 * 1024, stderr: 16 * 1024 },
      terminateOnOutputLimit: true,
    },
  );
  signal.throwIfAborted();
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
            .map((finding) => redactSupportString(finding.message, redaction, { maxLength: 200 }))
            .join("; ")}`,
  };
}
