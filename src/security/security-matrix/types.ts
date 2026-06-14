export const SECURITY_MATRIX_ACTORS = ["user", "agent", "system", "tool", "unknown"] as const;

export type SecurityMatrixActor = (typeof SECURITY_MATRIX_ACTORS)[number];

export const SECURITY_MATRIX_INFLUENCE_SOURCES = [
  "web_fetch",
  "browser",
  "email",
  "file",
  "github",
  "webhook",
  "memory",
  "skill",
  "api",
  "channel_metadata",
  "unknown_external",
] as const;

export type SecurityMatrixInfluenceSource = (typeof SECURITY_MATRIX_INFLUENCE_SOURCES)[number];

export type SecurityMatrixPolicySource = SecurityMatrixInfluenceSource | "none";

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

export const SECURITY_MATRIX_APPROVAL_STATES = [
  "none",
  "requested",
  "approved",
  "denied",
  "not_required",
] as const;

export type SecurityMatrixApprovalState = (typeof SECURITY_MATRIX_APPROVAL_STATES)[number];

export const SECURITY_MATRIX_OPERATOR_POLICIES = ["unknown", "allowed", "denied"] as const;

export type SecurityMatrixOperatorPolicy = (typeof SECURITY_MATRIX_OPERATOR_POLICIES)[number];

export const SECURITY_MATRIX_DECISIONS = ["allow", "warn", "require_confirm", "block"] as const;

export type SecurityMatrixDecision = (typeof SECURITY_MATRIX_DECISIONS)[number];

export type SecurityMatrixRule = {
  readonly decision: SecurityMatrixDecision;
  readonly reason: string;
};

export type SecurityMatrixPolicy = Partial<
  Record<
    SecurityMatrixPolicySource,
    Partial<Record<SecurityMatrixToolCapability, SecurityMatrixDecision | SecurityMatrixRule>>
  >
>;

export type SecurityMatrixEvaluationInput = {
  /** Actor requesting the tool call. This is not a trust source. */
  readonly actor?: string;
  /** Compatibility shorthand for a single influence source. Actor-like values are ignored. */
  readonly source?: string;
  /** External or stored content sources that influenced the tool decision. */
  readonly influencedBy?: readonly string[];
  readonly capability: string;
  readonly approvalState?: string;
  readonly operatorPolicy?: string;
  readonly policy?: SecurityMatrixPolicy;
  readonly defaultDecision?: SecurityMatrixDecision;
  /** Explicit escape hatch for owner-approved policy experiments that weaken defaults. */
  readonly allowPolicyWeakening?: boolean;
};

export type SecurityMatrixEvaluation = {
  readonly actor: SecurityMatrixActor;
  readonly source: SecurityMatrixPolicySource;
  readonly originalSource?: string;
  readonly influencedBy: readonly SecurityMatrixInfluenceSource[];
  readonly originalInfluences: readonly string[];
  readonly capability: SecurityMatrixToolCapability;
  readonly originalCapability: string;
  readonly approvalState: SecurityMatrixApprovalState;
  readonly operatorPolicy: SecurityMatrixOperatorPolicy;
  readonly policyDecision: SecurityMatrixDecision;
  readonly decision: SecurityMatrixDecision;
  readonly reason: string;
  readonly matched: "policy" | "fallback" | "operator_policy" | "approval_state";
};
