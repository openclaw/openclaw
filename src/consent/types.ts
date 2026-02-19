/**
 * ConsentGate data contracts.
 * Aligns with docs/grants/enterprise-consentgate-implementation-plan.md §6.
 */

import type { ConsentReasonCode } from "./reason-codes.js";

/** Consent token status: single-use consume, revoke, or TTL expiry. */
export type ConsentTokenStatus = "issued" | "consumed" | "revoked" | "expired";

/** Logical consent token (stored and validated). */
export type ConsentToken = {
  /** Unique id (JWT ID style). */
  jti: string;
  status: ConsentTokenStatus;
  tool: string;
  trustTier: string;
  sessionKey: string;
  contextHash: string;
  /** Optional by operation class. */
  bundleHash?: string;
  issuedAt: number;
  expiresAt: number;
  /** Principal that issued (e.g. operator id). */
  issuedBy: string;
  policyVersion: string;
  /** Optional tenant for multi-tenant isolation. */
  tenantId?: string;
};

/** WAL event type enum. */
export type WalEventType =
  | "CONSENT_ISSUED"
  | "CONSENT_CONSUMED"
  | "CONSENT_DENIED"
  | "CONSENT_REVOKED"
  | "CONSENT_EXPIRED"
  | "TIER_VIOLATION"
  | "CONTAINMENT_QUARANTINE"
  | "CASCADE_REVOKE"
  | "BUNDLE_MISMATCH"
  | "IDEMPOTENT_HIT";

/** Single WAL event (append-only). */
export type WalEvent = {
  eventId: string;
  ts: number;
  type: WalEventType;
  /** Null for no-token denials. */
  jti: string | null;
  tool: string;
  sessionKey: string;
  trustTier: string;
  /** allow | deny */
  decision: "allow" | "deny";
  reasonCode: string;
  correlationId: string;
  actor: Record<string, unknown>;
  tenantId: string;
};

/** Input to issue a consent token. */
export type ConsentIssueInput = {
  tool: string;
  trustTier: string;
  sessionKey: string;
  contextHash: string;
  bundleHash?: string;
  ttlMs: number;
  issuedBy: string;
  policyVersion: string;
  tenantId?: string;
  correlationId?: string;
};

/** Input to consume a consent token (single-use). */
export type ConsentConsumeInput = {
  jti: string;
  tool: string;
  trustTier: string;
  sessionKey: string;
  contextHash: string;
  bundleHash?: string;
  correlationId?: string;
  actor?: Record<string, unknown>;
  tenantId?: string;
};

/** Result of consume: allow with optional metadata, or deny with reason. */
export type ConsentConsumeResult =
  | { allowed: true }
  | {
      allowed: false;
      reasonCode: ConsentReasonCode | string;
      message?: string;
      correlationId?: string;
    };

/** Normalized denial payload for API surfaces (HTTP/WS) and runbooks. */
export type ConsentDenyPayload = {
  reasonCode: ConsentReasonCode | string;
  message: string;
  correlationId: string;
  tool: string;
  sessionKey: string;
  trustTier: string;
  jti: string | null;
};

/** Input to revoke (single jti or bulk). */
export type ConsentRevokeInput = {
  jti?: string;
  sessionKey?: string;
  tenantId?: string;
  correlationId?: string;
};

/** Status query and snapshot. */
export type ConsentStatusQuery = {
  sessionKey?: string;
  tenantId?: string;
  sinceMs?: number;
  limit?: number;
};

export type ConsentStatusSnapshot = {
  tokens: Array<Pick<ConsentToken, "jti" | "status" | "tool" | "sessionKey" | "issuedAt" | "expiresAt">>;
  recentEvents: WalEvent[];
};
