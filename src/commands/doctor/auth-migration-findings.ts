import type { HealthFinding } from "../../flows/health-checks.js";

/** Preserve migration receipts while reporting the producer's current or historical outcome. */
export function createAuthMigrationWarningRecorder(
  warnings: string[],
  findings: HealthFinding[],
  reportFindings?: (findings: readonly HealthFinding[], warnings?: readonly string[]) => void,
) {
  return (
    message: string,
    code: string,
    fixHint: string,
    target?: string,
    category: NonNullable<HealthFinding["category"]> = "fix-now",
    docsUrl = "https://docs.openclaw.ai/cli/doctor/running#auth-migration-recovery",
  ): void => {
    warnings.push(message);
    const finding: HealthFinding = {
      checkId: `core/doctor/auth-migration/${code}`,
      severity: "warning",
      category,
      message,
      fixHint,
      ...(target ? { target } : {}),
      docsUrl,
    };
    findings.push(finding);
    reportFindings?.([finding], [message]);
  };
}
