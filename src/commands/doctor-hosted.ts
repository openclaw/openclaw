import { createConfigIO } from "../config/config.js";
import { createCoreHealthChecks } from "../flows/doctor-core-checks.js";
import type { DoctorHealthCheckContext } from "../flows/doctor-health-contribution-types.js";
import { exitCodeFromFindings, runDoctorLintChecks } from "../flows/doctor-lint-flow.js";
import { healthFindingMeetsSeverity } from "../flows/health-checks.js";
import type { RuntimeEnv } from "../runtime.js";

// These existing checks read configuration, installation files, and runtime facts only.
// Full lint also runs writable plugin projections and whole-database inspections.
const HOSTED_CHECK_IDS = new Set([
  "core/doctor/final-config-validation",
  "core/doctor/gateway-config",
  "core/doctor/command-owner",
  "core/doctor/node-runtime",
  "core/doctor/runtime-capabilities",
  "core/doctor/stale-runtime-build",
  "core/doctor/ui-protocol-freshness",
]);

/** Hosted diagnosis never opens operator databases or prepares private inspection images. */
export async function runHostedDoctorLint(runtime: RuntimeEnv): Promise<number> {
  const snapshot = await createConfigIO({
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  const ctx: DoctorHealthCheckContext = {
    mode: "lint",
    runtime,
    cfg: snapshot.config,
    env: process.env,
    lintConfigSnapshot: snapshot,
  };
  const checks = createCoreHealthChecks().filter(
    (check) =>
      HOSTED_CHECK_IDS.has(check.id) &&
      (snapshot.valid || check.id !== "core/doctor/gateway-config"),
  );
  const result = await runDoctorLintChecks(ctx, { checks });
  const visible = result.findings.filter((finding) =>
    healthFindingMeetsSeverity(finding, "warning"),
  );
  runtime.log(
    `Doctor (live Gateway): ran ${result.checksRun} check(s), ${visible.length} finding(s)`,
  );
  for (const finding of visible) {
    runtime.log(
      `  [${finding.severity}] ${finding.checkId} - ${finding.path ? `${finding.path}: ` : ""}${finding.message}`,
    );
    if (finding.fixHint) {
      runtime.log(`    fix: ${finding.fixHint}`);
    }
  }
  runtime.log(
    "Database, plugin, credential, and workspace inspections were deferred to avoid copying or changing live Gateway state. Run `openclaw doctor --lint` on this host with the Gateway stopped for the full report; repairs require `openclaw doctor --fix`.",
  );
  return exitCodeFromFindings(result.findings);
}
