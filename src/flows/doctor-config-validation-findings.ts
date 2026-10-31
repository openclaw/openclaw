import type { ConfigValidationIssue } from "../config/types.openclaw.js";
import { createUpdateFailureFact } from "../infra/update-failure-facts.js";
import { isConfiguredPluginPathDiagnosticCode } from "../plugins/discovery-availability.js";
import { PLUGIN_AVAILABILITY_POLICY } from "../plugins/runtime-degraded-state.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import { isUpdateDoctorRun } from "./doctor-health-contribution-utils.js";
import { renderStructuredHealthFindings } from "./doctor-health-contribution.js";
import type { HealthFinding } from "./health-checks.js";

export const FINAL_CONFIG_VALIDATION_CHECK_ID = "core/doctor/final-config-validation";

export function configValidationIssuesToHealthFindings(
  issues: readonly ConfigValidationIssue[],
): readonly HealthFinding[] {
  return issues.map((issue): HealthFinding => ({
    checkId: FINAL_CONFIG_VALIDATION_CHECK_ID,
    severity: "error",
    message: issue.message,
    path: issue.path || "<root>",
    requirement: "valid-config",
    fixHint:
      issue.fixHint ??
      "Run `openclaw doctor --fix` to migrate or remove retired keys. If no migration applies, correct the value or use `openclaw config unset <key>` with the rejected key path, then rerun Doctor.",
  }));
}

export function configValidationWarningsToHealthFindings(
  warnings: readonly ConfigValidationIssue[],
): readonly HealthFinding[] {
  return warnings
    .filter(
      (warning) =>
        isConfiguredPluginPathDiagnosticCode(warning.code) && warning.path === "plugins.load.paths",
    )
    .map((warning) => ({
      checkId: FINAL_CONFIG_VALIDATION_CHECK_ID,
      severity: PLUGIN_AVAILABILITY_POLICY.severity,
      target: PLUGIN_AVAILABILITY_POLICY.state,
      requirement: warning.code,
      source: warning.source,
      errorCode: warning.errorCode,
      message: warning.message,
      path: warning.path,
      fixHint: warning.fixHint ?? PLUGIN_AVAILABILITY_POLICY.repairCommand,
    }));
}

export async function runFinalConfigValidationHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const { readDeferredPluginMigrationsAsync } =
    await import("../infra/deferred-plugin-migrations.js");
  const deferredPluginMigrations = await readDeferredPluginMigrationsAsync({
    env: ctx.env ?? process.env,
  });
  const finalSnapshot = await readConfigFileSnapshot({
    skipPluginValidation: isUpdateDoctorRun(ctx.env ?? process.env),
    preservedLegacyRootKeys: ctx.configResult.preservedLegacyRootKeys,
    deferredPluginMigrations,
  });
  const findings: HealthFinding[] = [
    ...(finalSnapshot.exists && !finalSnapshot.valid
      ? configValidationIssuesToHealthFindings(finalSnapshot.issues)
      : []),
    ...(ctx.configResult.stateMigrationStepReceipts ?? [])
      .filter((receipt) => receipt.requiredness === "required" && receipt.outcome === "deferred")
      .map((receipt): HealthFinding => ({
        checkId: `core/doctor/${receipt.id}`,
        severity: "error",
        requirement: "required-migration-deferred",
        message:
          (receipt.refusal?.message ?? receipt.warnings.join("\n")) ||
          `Required migration ${receipt.id} was deferred.`,
        fixHint:
          "Resolve the reported blocker, then rerun `openclaw doctor --fix` before restarting the Gateway.",
      })),
  ];
  if (findings.length > 0) {
    renderStructuredHealthFindings(ctx, findings);
    ctx.postInstallDoctorResult = {
      status: "error",
      failureFacts: [
        ...(ctx.postInstallDoctorResult?.failureFacts ?? []),
        ...findings.map((finding) =>
          createUpdateFailureFact({
            check: finding.checkId,
            code: finding.requirement ?? "doctor-repair-blocked",
            message: `${finding.path ? `${finding.path}: ` : ""}${finding.message} ${finding.fixHint}`,
          }),
        ),
      ],
    };
  }
}
