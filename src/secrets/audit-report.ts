/** Stable finding codes emitted by `openclaw secrets audit`. */
export type SecretsAuditCode =
  | "PLAINTEXT_FOUND"
  | "REF_UNRESOLVED"
  | "REF_SHADOWED"
  | "LEGACY_RESIDUE";

/** Audit severity used for CLI output and check-mode exit behavior. */
export type SecretsAuditSeverity = "info" | "warn" | "error"; // pragma: allowlist secret

/** One secret audit finding with file/path context. */
export type SecretsAuditFinding = {
  code: SecretsAuditCode;
  severity: SecretsAuditSeverity;
  file: string;
  jsonPath: string;
  message: string;
  provider?: string;
  profileId?: string;
};

/** Overall audit state derived from findings and unresolved refs. */
export type SecretsAuditStatus = "clean" | "findings" | "unresolved"; // pragma: allowlist secret

/** Structured report returned by the secrets audit command. */
export type SecretsAuditReport = {
  version: 1;
  status: SecretsAuditStatus;
  resolution: {
    refsChecked: number;
    skippedExecRefs: number;
    resolvabilityComplete: boolean;
  };
  filesScanned: string[];
  summary: {
    plaintextCount: number;
    unresolvedRefCount: number;
    shadowedRefCount: number;
    legacyResidueCount: number;
  };
  findings: SecretsAuditFinding[];
};

const SEVERITY_RANK: Record<SecretsAuditSeverity, number> = {
  info: 0,
  warn: 1,
  error: 2,
};

export function parseSecretsAuditSeverity(value: string): SecretsAuditSeverity | null {
  if (value === "warning") {
    return "warn";
  }
  return value === "info" || value === "warn" || value === "error" ? value : null;
}

/** Maps audit results to CLI exit codes. */
export function resolveSecretsAuditExitCode(
  report: SecretsAuditReport,
  check: boolean,
  severityMin: SecretsAuditSeverity = "info",
): number {
  if (report.summary.unresolvedRefCount > 0) {
    return 2;
  }
  const hasBlockingFinding = report.findings.some(
    (finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[severityMin],
  );
  return check && hasBlockingFinding ? 1 : 0;
}
