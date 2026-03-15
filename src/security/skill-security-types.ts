export const SKILL_SCAN_PROVIDERS = ["mock", "virustotal", "local"] as const;
export const SKILL_SCAN_STATUSES = ["queued", "complete", "error", "not_found"] as const;
export const SKILL_SECURITY_VERDICTS = [
  "benign",
  "suspicious",
  "malicious",
  "unknown",
  "error",
] as const;
export const SKILL_SECURITY_POLICY_ACTIONS = [
  "allow",
  "warn",
  "block",
  "manual_review",
] as const;

export type SkillScanProvider = (typeof SKILL_SCAN_PROVIDERS)[number];
export type SkillScanStatus = (typeof SKILL_SCAN_STATUSES)[number];
export type SkillSecurityVerdict = (typeof SKILL_SECURITY_VERDICTS)[number];
export type SkillSecurityPolicyAction = (typeof SKILL_SECURITY_POLICY_ACTIONS)[number];

export type SkillSecurityPublisherMetadata = {
  publisherId: string;
  displayName?: string;
  contact?: string;
  url?: string;
  trustLevel?: "first_party" | "known" | "unknown";
};

export type SkillSecurityPackageMetadata = {
  formatVersion: 1;
  skillName: string;
  version: string;
  publisher: SkillSecurityPublisherMetadata;
  createdAt: string;
  sourceFiles: string[];
  packageHashSha256: string | null;
  packaging: {
    ordering: "lexical";
    compression: "STORE";
    timestamp: string;
  };
};

export type SkillSecurityScannerFinding = {
  ruleId: string;
  severity: "info" | "warn" | "critical";
  file: string;
  line: number;
  message: string;
  evidence: string;
};

export type SkillSecurityScanRecord = {
  provider: SkillScanProvider;
  scanId: string | null;
  status: SkillScanStatus;
  verdict: SkillSecurityVerdict;
  confidence: number;
  packageHashSha256: string;
  scannedAt: string;
  lastRescannedAt?: string | null;
  reportUrl?: string | null;
  findings: SkillSecurityScannerFinding[];
  summary: string;
  raw?: Record<string, unknown> | null;
};

export type SkillSecurityPolicyDecision = {
  action: SkillSecurityPolicyAction;
  reasons: string[];
  decidedAt: string;
};

export type SkillSecurityVersionRecord = {
  version: string;
  active: boolean;
  bundlePath?: string | null;
  metadata: SkillSecurityPackageMetadata;
  packageHashSha256: string;
  publisher: SkillSecurityPublisherMetadata;
  scans: SkillSecurityScanRecord[];
  latestVerdict: SkillSecurityVerdict;
  latestPolicyAction: SkillSecurityPolicyAction | null;
  firstScannedAt?: string | null;
  lastScannedAt?: string | null;
  lastRescannedAt?: string | null;
  externalReportUrl?: string | null;
};

export type SkillSecurityPackageRecord = {
  skillName: string;
  publisher: SkillSecurityPublisherMetadata;
  versions: SkillSecurityVersionRecord[];
};

export type SkillSecurityAuditEntry = {
  ts: string;
  actor: string | null;
  skillName: string;
  version: string;
  packageHashSha256: string;
  event:
    | "packaged"
    | "scanned"
    | "rescanned"
    | "verdict_changed"
    | "policy_decision"
    | "downgrade_warning";
  detail: string;
};

export type SkillSecurityStore = {
  version: 1;
  packages: SkillSecurityPackageRecord[];
  auditTrail: SkillSecurityAuditEntry[];
};
