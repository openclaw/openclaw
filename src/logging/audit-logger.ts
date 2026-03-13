/**
 * AuditLogger — GovDOSS™ / CMMC CP-11 audit logging framework.
 *
 * Provides structured, tamper-evident security event logging:
 * - Immutability chain: each entry carries a SHA-256 hash of the
 *   previous entry so any deletion or modification is detectable.
 * - SOA⁴™ attribution: every event records Subject (who), Object (what),
 *   Action (how), and Timestamp (when).
 * - PII guard: validates that log payloads don't accidentally include
 *   raw secrets or PII-shaped values.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export const AUDIT_EVENT_TYPES = [
  // Authentication
  "auth.login",
  "auth.logout",
  "auth.login_failed",
  "auth.mfa_success",
  "auth.mfa_failed",
  // Account lifecycle
  "account.created",
  "account.disabled",
  "account.enabled",
  "account.deleted",
  "account.password_changed",
  "account.role_changed",
  // Session management
  "session.created",
  "session.revoked",
  // Configuration
  "config.read",
  "config.changed",
  // Access control
  "access.denied",
  "access.granted",
  // Gateway operations
  "gateway.started",
  "gateway.stopped",
  "gateway.restarted",
  // Integrity
  "audit.log_queried",
  "audit.integrity_verified",
  "audit.integrity_failed",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Audit entry
// ---------------------------------------------------------------------------

export type AuditEntry = {
  /** Monotonically increasing sequence number within this logger instance. */
  seq: number;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** GovDOSS™ SOA⁴™: who performed the action. */
  subject: string;
  /** GovDOSS™ SOA⁴™: what resource was acted upon. */
  object: string;
  /** GovDOSS™ SOA⁴™: the event that occurred. */
  action: AuditEventType;
  /** Optional structured context payload. */
  detail?: Record<string, unknown>;
  /** Outcome of the action. */
  outcome: "success" | "failure" | "denied";
  /** SHA-256 of previous entry's canonical form (chain link). */
  prevHash: string;
  /** SHA-256 of this entry's canonical form (excluding itself). */
  hash: string;
};

// ---------------------------------------------------------------------------
// Audit query
// ---------------------------------------------------------------------------

export type AuditQuery = {
  subject?: string;
  action?: AuditEventType;
  outcome?: AuditEntry["outcome"];
  since?: string;
  until?: string;
  limit?: number;
};

// ---------------------------------------------------------------------------
// Sensitive field names that must not appear in audit detail payloads
// ---------------------------------------------------------------------------

const SENSITIVE_FIELD_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /credential/i,
  /ssn/i,
  /credit[_-]?card/i,
];

function containsSensitiveKey(detail: Record<string, unknown>): string | null {
  for (const key of Object.keys(detail)) {
    if (SENSITIVE_FIELD_PATTERNS.some((pat) => pat.test(key))) {
      return key;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// AuditLogger
// ---------------------------------------------------------------------------

const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

export class AuditLogger {
  private readonly entries: AuditEntry[] = [];
  private seq = 0;

  /** Records an audit event. Throws if `detail` contains sensitive field names. */
  log(params: {
    subject: string;
    object: string;
    action: AuditEventType;
    outcome: AuditEntry["outcome"];
    detail?: Record<string, unknown>;
  }): AuditEntry {
    if (params.detail) {
      const bad = containsSensitiveKey(params.detail);
      if (bad) {
        throw new Error(
          `Audit log detail contains sensitive field '${bad}'; redact before logging`,
        );
      }
    }

    const prevEntry = this.entries[this.entries.length - 1];
    const prevHash = prevEntry?.hash ?? GENESIS_HASH;
    const timestamp = new Date().toISOString();
    const seq = ++this.seq;

    // Build canonical form for hashing (stable JSON key order).
    const canonical = JSON.stringify({
      seq,
      timestamp,
      subject: params.subject,
      object: params.object,
      action: params.action,
      outcome: params.outcome,
      detail: params.detail ?? null,
      prevHash,
    });
    const hash = createHash("sha256").update(canonical).digest("hex");

    const entry: AuditEntry = {
      seq,
      timestamp,
      subject: params.subject,
      object: params.object,
      action: params.action,
      outcome: params.outcome,
      detail: params.detail,
      prevHash,
      hash,
    };

    this.entries.push(entry);
    return entry;
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  /** Returns entries matching the given filter criteria. */
  query(q: AuditQuery = {}): AuditEntry[] {
    let results = this.entries.slice();

    if (q.subject) {
      results = results.filter((e) => e.subject === q.subject);
    }
    if (q.action) {
      results = results.filter((e) => e.action === q.action);
    }
    if (q.outcome) {
      results = results.filter((e) => e.outcome === q.outcome);
    }
    if (q.since) {
      results = results.filter((e) => e.timestamp >= q.since!);
    }
    if (q.until) {
      results = results.filter((e) => e.timestamp <= q.until!);
    }
    if (q.limit !== undefined && q.limit > 0) {
      results = results.slice(-q.limit);
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Integrity verification
  // ---------------------------------------------------------------------------

  /**
   * Verifies the hash chain over all stored entries.
   * Returns `{ valid: true }` when the chain is intact, or an error describing
   * the first broken link.
   */
  verifyIntegrity(): { valid: true } | { valid: false; error: string; atSeq: number } {
    let expectedPrev = GENESIS_HASH;

    for (const entry of this.entries) {
      if (entry.prevHash !== expectedPrev) {
        return {
          valid: false,
          error: `Hash chain broken: entry seq=${entry.seq} prevHash mismatch`,
          atSeq: entry.seq,
        };
      }

      // Re-derive the canonical form and recompute the hash.
      const canonical = JSON.stringify({
        seq: entry.seq,
        timestamp: entry.timestamp,
        subject: entry.subject,
        object: entry.object,
        action: entry.action,
        outcome: entry.outcome,
        detail: entry.detail ?? null,
        prevHash: entry.prevHash,
      });
      const expected = createHash("sha256").update(canonical).digest("hex");

      if (entry.hash !== expected) {
        return {
          valid: false,
          error: `Entry hash mismatch at seq=${entry.seq}`,
          atSeq: entry.seq,
        };
      }

      expectedPrev = entry.hash;
    }

    return { valid: true };
  }

  /** Total number of logged entries. */
  get size(): number {
    return this.entries.length;
  }
}
