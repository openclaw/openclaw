export type PolicyGuardrailsConfig = {
  /** Enable signed policy guardrails. Default: false. */
  enabled?: boolean;
  /** Path to signed policy JSON. Default: ~/.openclaw/POLICY.json */
  policyPath?: string;
  /** Path to detached policy signature (base64). Default: ~/.openclaw/POLICY.sig */
  sigPath?: string;
  /** Optional path to persisted anti-rollback state. Default: ~/.openclaw/POLICY.state.json */
  statePath?: string;
  /** Base64 ed25519 public key used to verify POLICY.sig for POLICY.json. */
  publicKey?: string;
  /** Optional trusted ed25519 public keys keyed by key ID for key rotation. */
  publicKeys?: Record<string, string>;
  /** Enforce lockdown on missing/invalid signature when enabled. Default: true. */
  failClosed?: boolean;
  /** Require secure file ownership/permissions for policy artifacts. Default: true. */
  strictFilePermissions?: boolean;
  /** Enforce non-decreasing policySerial/issuedAt values to prevent rollback. Default: true. */
  enforceMonotonicSerial?: boolean;
};
