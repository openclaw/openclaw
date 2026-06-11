export const SECURITY_MATRIX_TRUST_SOURCES = [
  "agent",
  "user",
  "web_fetch",
  "browser",
  "email",
  "file",
  "github",
  "webhook",
  "memory",
  "skill",
  "unknown_external",
] as const;

export type SecurityMatrixTrustSource = (typeof SECURITY_MATRIX_TRUST_SOURCES)[number];

export const SECURITY_MATRIX_TOOL_CAPABILITIES = [
  "read_file",
  "write_file",
  "network",
  "browser",
  "exec",
  "git",
  "email_send",
  "calendar_write",
  "credential_access",
  "system_config",
  "memory_read",
  "memory_write",
  "unknown",
] as const;

export type SecurityMatrixToolCapability = (typeof SECURITY_MATRIX_TOOL_CAPABILITIES)[number];

export const SECURITY_MATRIX_DECISIONS = ["allow", "warn", "require_confirm", "block"] as const;

export type SecurityMatrixDecision = (typeof SECURITY_MATRIX_DECISIONS)[number];

export type SecurityMatrixRule = {
  readonly decision: SecurityMatrixDecision;
  readonly reason: string;
};

export type SecurityMatrixPolicy = Partial<
  Record<
    SecurityMatrixTrustSource,
    Partial<Record<SecurityMatrixToolCapability, SecurityMatrixDecision | SecurityMatrixRule>>
  >
>;

export type SecurityMatrixEvaluationInput = {
  readonly source: string;
  readonly capability: string;
  readonly policy?: SecurityMatrixPolicy;
  readonly defaultDecision?: SecurityMatrixDecision;
};

export type SecurityMatrixEvaluation = {
  readonly source: SecurityMatrixTrustSource;
  readonly originalSource: string;
  readonly capability: SecurityMatrixToolCapability;
  readonly originalCapability: string;
  readonly decision: SecurityMatrixDecision;
  readonly reason: string;
  readonly matched: "policy" | "fallback";
};
