import { scanLiteralSecrets } from "../security/scanner.js";
import type { PreparedSkillProposalSupportFile, SkillProposalScan } from "./types.js";

export function scanProposalBundle(
  content: string,
  supportFiles: readonly PreparedSkillProposalSupportFile[] = [],
  metadata: readonly { file: string; content: string | undefined }[] = [],
): SkillProposalScan {
  const scannedAt = new Date().toISOString();
  // Admission rejects recognized credentials. Code heuristics remain diagnostics
  // for explicit audits and plugin release scans, not publication policy.
  const findings = [
    ...scanLiteralSecrets(content, "PROPOSAL.md"),
    ...supportFiles.flatMap((file) => [
      ...scanLiteralSecrets(file.path, "support-file-path"),
      ...scanLiteralSecrets(file.content, file.path),
    ]),
    ...metadata.flatMap((entry) =>
      entry.content ? scanLiteralSecrets(entry.content, entry.file) : [],
    ),
  ];
  return {
    state: findings.length > 0 ? "failed" : "clean",
    scannedAt,
    critical: findings.length,
    warn: 0,
    info: 0,
    findings,
  };
}

export function assertProposalContainsNoLiteralSecrets(scan: SkillProposalScan): void {
  const finding = scan.findings.find((entry) => entry.ruleId === "literal-secret");
  if (!finding) {
    return;
  }
  throw new Error(
    `Skill proposal contains a recognized literal credential in ${finding.file}; replace it with a SecretRef or placeholder.`,
  );
}
