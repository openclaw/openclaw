// Health check adapters preserve check metadata and structured finding identities.
import type { SecurityAuditFinding } from "../security/audit.types.js";
import type { DoctorHealthCheck } from "./health-check-runner-types.js";
import type { HealthFinding } from "./health-checks.js";

export function copyHealthCheck(check: DoctorHealthCheck): DoctorHealthCheck {
  return { ...check };
}

// Snapshot metadata now; method lookup and receiver remain owned by the input check.
export function normalizeHealthCheck(check: DoctorHealthCheck): DoctorHealthCheck {
  return {
    id: check.id,
    kind: check.kind,
    description: check.description,
    source: check.source,
    defaultEnabled: check.defaultEnabled,
    updateReadiness: check.updateReadiness,
    detect: (ctx, scope) => check.detect(ctx, scope),
    repair:
      check.repair === undefined
        ? undefined
        : (ctx, findings) => check.repair?.(ctx, findings) ?? Promise.resolve({ changes: [] }),
  };
}

export function securityAuditFindingToHealthFinding(finding: SecurityAuditFinding): HealthFinding {
  const [firstDetail, ...detailLines] = finding.detail.split("\n");
  const fixHint = [...detailLines, ...(finding.remediation?.split("\n") ?? [])].join("\n");
  return {
    checkId: "core/doctor/security",
    requirement: finding.checkId,
    severity:
      finding.severity === "critical" ? "error" : finding.severity === "warn" ? "warning" : "info",
    message: `${finding.title}${firstDetail ? `: ${firstDetail}` : ""}`,
    ...(fixHint ? { fixHint } : {}),
  };
}
