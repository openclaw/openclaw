/**
 * Consent token state store (v1).
 * Atomic transitions: issued -> consumed | revoked | expired.
 */

import { randomUUID } from "node:crypto";
import type { ConsentToken, ConsentTokenStatus } from "./types.js";
import { CONSENT_REASON } from "./reason-codes.js";

/** Used by in-memory and file-backed stores. */
export const ALLOWED_TRANSITIONS: Record<ConsentTokenStatus, ConsentTokenStatus[]> = {
  issued: ["consumed", "revoked", "expired"],
  consumed: [],
  revoked: [],
  expired: [],
};

export type TokenStore = {
  put(token: ConsentToken): void;
  get(jti: string): ConsentToken | undefined;
  /** Atomic transition to new status. Returns true if transition applied. */
  transition(jti: string, toStatus: ConsentTokenStatus): boolean;
  /** Find by sessionKey and optionally tenantId. */
  findBySession(sessionKey: string, tenantId?: string): ConsentToken[];
  /** List all tokens, optionally filtered by tenantId. */
  list(tenantId?: string): ConsentToken[];
  /** Remove expired entries (best-effort). */
  pruneExpired(nowMs: number): number;
};

export function createInMemoryTokenStore(): TokenStore {
  const map = new Map<string, ConsentToken>();

  return {
    put(token) {
      map.set(token.jti, { ...token });
    },
    get(jti) {
      return map.get(jti);
    },
    transition(jti, toStatus) {
      const token = map.get(jti);
      if (!token) return false;
      const allowed = ALLOWED_TRANSITIONS[token.status];
      if (!allowed?.includes(toStatus)) return false;
      token.status = toStatus;
      return true;
    },
    findBySession(sessionKey, tenantId) {
      const out: ConsentToken[] = [];
      for (const t of map.values()) {
        if (t.sessionKey !== sessionKey) continue;
        if (tenantId != null && (t as Record<string, unknown>).tenantId !== tenantId) continue;
        out.push(t);
      }
      return out;
    },
    list(tenantId) {
      const out: ConsentToken[] = [];
      for (const t of map.values()) {
        if (tenantId != null && (t as Record<string, unknown>).tenantId !== tenantId) continue;
        out.push(t);
      }
      return out;
    },
    pruneExpired(nowMs) {
      let n = 0;
      for (const [jti, t] of map.entries()) {
        if (t.expiresAt < nowMs && t.status === "issued") {
          t.status = "expired";
          n++;
        }
      }
      return n;
    },
  };
}

/** Build a new token from issue input. */
export function buildToken(input: {
  tool: string;
  trustTier: string;
  sessionKey: string;
  contextHash: string;
  bundleHash?: string;
  ttlMs: number;
  issuedBy: string;
  policyVersion: string;
  tenantId?: string;
}): ConsentToken {
  const now = Date.now();
  return {
    jti: randomUUID(),
    status: "issued",
    tool: input.tool,
    trustTier: input.trustTier,
    sessionKey: input.sessionKey,
    contextHash: input.contextHash,
    bundleHash: input.bundleHash,
    issuedAt: now,
    expiresAt: now + input.ttlMs,
    issuedBy: input.issuedBy,
    policyVersion: input.policyVersion,
    tenantId: input.tenantId,
  };
}

export { CONSENT_REASON };
