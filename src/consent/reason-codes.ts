/**
 * Deterministic reason code registry for ConsentGate decisions.
 * All deny/allow paths use these codes for audit and client handling.
 */

export const CONSENT_REASON = {
  /** Token not provided in request. */
  NO_TOKEN: "CONSENT_NO_TOKEN",
  /** Token not found in store. */
  TOKEN_NOT_FOUND: "CONSENT_TOKEN_NOT_FOUND",
  /** Token already consumed (replay). */
  TOKEN_ALREADY_CONSUMED: "CONSENT_TOKEN_ALREADY_CONSUMED",
  /** Token revoked. */
  TOKEN_REVOKED: "CONSENT_TOKEN_REVOKED",
  /** Token expired (TTL). */
  TOKEN_EXPIRED: "CONSENT_TOKEN_EXPIRED",
  /** Tool name does not match token. */
  TOOL_MISMATCH: "CONSENT_TOOL_MISMATCH",
  /** Trust tier does not match or not allowed for tool. */
  TIER_VIOLATION: "CONSENT_TIER_VIOLATION",
  /** Session key does not match token. */
  SESSION_MISMATCH: "CONSENT_SESSION_MISMATCH",
  /** Context hash does not match (anti-laundering). */
  CONTEXT_MISMATCH: "CONSENT_CONTEXT_MISMATCH",
  /** Bundle hash mismatch when required. */
  BUNDLE_MISMATCH: "CONSENT_BUNDLE_MISMATCH",
  /** Principal/session in quarantine. */
  CONTAINMENT_QUARANTINE: "CONSENT_CONTAINMENT_QUARANTINE",
  /** Sliding-window op cap exceeded for session. */
  RATE_LIMIT: "CONSENT_RATE_LIMIT",
  /** ConsentGate unavailable (fail closed). */
  UNAVAILABLE: "CONSENT_UNAVAILABLE",
  /** Policy version mismatch. */
  POLICY_VERSION_MISMATCH: "CONSENT_POLICY_VERSION_MISMATCH",
  /** Allowed (for WAL). */
  ALLOWED: "CONSENT_ALLOWED",
  /** Idempotent consume (already recorded). */
  IDEMPOTENT_HIT: "CONSENT_IDEMPOTENT_HIT",
} as const;

export type ConsentReasonCode = (typeof CONSENT_REASON)[keyof typeof CONSENT_REASON];

/** Set of all valid reason codes (for validation). */
export const CONSENT_REASON_CODES = new Set<string>(Object.values(CONSENT_REASON));

/** Stable human-readable messages for operator logs and API responses. */
export const CONSENT_REASON_MESSAGE: Record<ConsentReasonCode, string> = {
  [CONSENT_REASON.NO_TOKEN]: "Consent token is required for this operation.",
  [CONSENT_REASON.TOKEN_NOT_FOUND]: "Consent token was not found.",
  [CONSENT_REASON.TOKEN_ALREADY_CONSUMED]:
    "Consent token was already consumed (single-use replay blocked).",
  [CONSENT_REASON.TOKEN_REVOKED]: "Consent token was revoked.",
  [CONSENT_REASON.TOKEN_EXPIRED]: "Consent token expired.",
  [CONSENT_REASON.TOOL_MISMATCH]: "Consent token tool does not match requested tool.",
  [CONSENT_REASON.TIER_VIOLATION]: "Trust tier is not authorized for this tool.",
  [CONSENT_REASON.SESSION_MISMATCH]: "Consent token session does not match request session.",
  [CONSENT_REASON.CONTEXT_MISMATCH]:
    "Consent context hash mismatch (possible laundering or stale context).",
  [CONSENT_REASON.BUNDLE_MISMATCH]: "Consent bundle hash mismatch.",
  [CONSENT_REASON.CONTAINMENT_QUARANTINE]:
    "Operation blocked while containment quarantine is active.",
  [CONSENT_REASON.RATE_LIMIT]:
    "Consent rate limit exceeded for this session (too many issues/consumes in window).",
  [CONSENT_REASON.UNAVAILABLE]: "Consent service is unavailable (fail closed).",
  [CONSENT_REASON.POLICY_VERSION_MISMATCH]:
    "Consent token policy version does not match active policy version.",
  [CONSENT_REASON.ALLOWED]: "Consent allowed.",
  [CONSENT_REASON.IDEMPOTENT_HIT]: "Idempotent consent replay detected.",
};

export function getConsentReasonMessage(code: string): string {
  if (CONSENT_REASON_CODES.has(code)) {
    return CONSENT_REASON_MESSAGE[code as ConsentReasonCode];
  }
  return "Consent denied.";
}
