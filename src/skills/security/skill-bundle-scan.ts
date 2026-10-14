import { scanSkillContent, scanSource, type SkillScanFinding } from "./scanner.js";

export type SkillBundleScan = {
  critical: number;
  findings: SkillScanFinding[];
};

/** Scans one skill file's content with the skill-instruction and embedded-source rules. */
export function scanSkillFile(content: string, label: string): SkillScanFinding[] {
  return [...scanSkillContent(content, label), ...scanSource(content, label)];
}

/** Support-file paths are checked for literal secrets only. */
export function scanSupportFilePath(path: string): SkillScanFinding[] {
  return scanSkillContent(path, "support-file-path").filter(
    (finding) => finding.ruleId === "literal-secret",
  );
}

/** Scans SKILL.md plus support files and their paths. */
export function scanSkillBundle(
  content: string,
  supportFiles: readonly { path: string; content: string }[] = [],
): SkillBundleScan {
  const findings = [
    ...scanSkillFile(content, "SKILL.md"),
    ...supportFiles.flatMap((file) => [
      ...scanSupportFilePath(file.path),
      ...scanSkillFile(file.content, file.path),
    ]),
  ];
  return {
    critical: findings.filter((finding) => finding.severity === "critical").length,
    findings,
  };
}

export function assertSkillBundleHasNoLiteralSecrets(scan: SkillBundleScan): void {
  const finding = scan.findings.find((entry) => entry.ruleId === "literal-secret");
  if (!finding) {
    return;
  }
  throw new Error(
    `Skill contains a recognized literal credential in ${finding.file}; replace it with a SecretRef or placeholder.`,
  );
}
