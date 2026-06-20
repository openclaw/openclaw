/** Top-level doctor command wrapper, including post-upgrade probe mode. */
import type { DoctorHealthResult } from "../flows/doctor-health-contributions.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { runPostUpgradeProbes } from "./doctor-post-upgrade.js";
import type { DoctorOptions } from "./doctor-prompter.js";

/** Runs doctor or the post-upgrade probe submode using the provided runtime. */
export async function doctorCommand(
  runtime?: RuntimeEnv,
  options?: DoctorOptions,
): Promise<DoctorHealthResult> {
  if (options?.postUpgrade) {
    const outputRuntime = runtime ?? defaultRuntime;
    const report = await runPostUpgradeProbes({});
    if (options.json) {
      writeRuntimeJson(outputRuntime, report);
    } else {
      for (const f of report.findings) {
        outputRuntime.log(`[${f.level}] ${f.code}: ${f.message}`);
      }
      if (report.findings.length === 0) {
        outputRuntime.log("post-upgrade: no findings");
      }
    }
    const hasError = report.findings.some((f) => f.level === "error");
    outputRuntime.exit(hasError ? 1 : 0);
    return { finalConfigInvalid: false };
  }
  const doctorHealth = await import("../flows/doctor-health.js");
  return doctorHealth.doctorCommand(runtime, options);
}
