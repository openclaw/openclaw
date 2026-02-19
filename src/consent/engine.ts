/**
 * ConsentGate engine: implements ConsentGateApi using token store and WAL.
 */

import type {
  ConsentConsumeInput,
  ConsentConsumeResult,
  ConsentIssueInput,
  ConsentRevokeInput,
  ConsentStatusQuery,
  ConsentStatusSnapshot,
  ConsentToken,
} from "./types.js";
import type { ConsentGateApi } from "./api.js";
import type { TokenStore } from "./store.js";
import type { WalWriter } from "./wal.js";
import { CONSENT_REASON } from "./reason-codes.js";
import { buildToken } from "./store.js";

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type ConsentEngineDeps = {
  store: TokenStore;
  wal: WalWriter;
  policyVersion: string;
  /** Optional: sessionKeys or tenantIds in this set are quarantined (no issue/consume). */
  quarantine?: Set<string>;
};

export function createConsentEngine(deps: ConsentEngineDeps): ConsentGateApi {
  const { store, wal, policyVersion, quarantine } = deps;

  function isQuarantined(sessionKey: string, tenantId?: string): boolean {
    if (!quarantine?.size) return false;
    return quarantine.has(sessionKey) || (tenantId != null && tenantId !== "" && quarantine.has(tenantId));
  }

  return {
    async issue(input: ConsentIssueInput): Promise<ConsentToken | null> {
      if (isQuarantined(input.sessionKey, input.tenantId)) {
        wal.append({
          type: "CONTAINMENT_QUARANTINE",
          jti: null,
          tool: input.tool,
          sessionKey: input.sessionKey,
          trustTier: input.trustTier,
          decision: "deny",
          reasonCode: CONSENT_REASON.CONTAINMENT_QUARANTINE,
          correlationId: input.correlationId ?? "",
          actor: { issuedBy: input.issuedBy },
          tenantId: input.tenantId ?? "",
        });
        return null;
      }
      const ttlMs = input.ttlMs > 0 ? input.ttlMs : DEFAULT_TTL_MS;
      const token = buildToken({
        tool: input.tool,
        trustTier: input.trustTier,
        sessionKey: input.sessionKey,
        contextHash: input.contextHash,
        bundleHash: input.bundleHash,
        ttlMs,
        issuedBy: input.issuedBy,
        policyVersion: input.policyVersion,
        tenantId: input.tenantId,
      });
      token.tenantId = input.tenantId;
      store.put(token);
      wal.append({
        type: "CONSENT_ISSUED",
        jti: token.jti,
        tool: token.tool,
        sessionKey: token.sessionKey,
        trustTier: token.trustTier,
        decision: "allow",
        reasonCode: CONSENT_REASON.ALLOWED,
        correlationId: input.correlationId ?? "",
        actor: { issuedBy: input.issuedBy },
        tenantId: input.tenantId ?? "",
      });
      return token;
    },

    async evaluate(input: ConsentConsumeInput): Promise<ConsentConsumeResult> {
      return evaluateOnly(store, wal, policyVersion, quarantine, input);
    },

    async consume(input: ConsentConsumeInput): Promise<ConsentConsumeResult> {
      if (isQuarantined(input.sessionKey, input.tenantId)) {
        wal.append({
          type: "CONTAINMENT_QUARANTINE",
          jti: input.jti || null,
          tool: input.tool,
          sessionKey: input.sessionKey,
          trustTier: input.trustTier,
          decision: "deny",
          reasonCode: CONSENT_REASON.CONTAINMENT_QUARANTINE,
          correlationId: input.correlationId ?? "",
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        return { allowed: false, reasonCode: CONSENT_REASON.CONTAINMENT_QUARANTINE };
      }
      const token = store.get(input.jti);
      if (!token) {
        wal.append({
          type: "CONSENT_DENIED",
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          trustTier: input.trustTier,
          decision: "deny",
          reasonCode: CONSENT_REASON.TOKEN_NOT_FOUND,
          correlationId: input.correlationId ?? "",
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        return { allowed: false, reasonCode: CONSENT_REASON.TOKEN_NOT_FOUND };
      }
      if (token.status !== "issued") {
        const reason =
          token.status === "consumed"
            ? CONSENT_REASON.TOKEN_ALREADY_CONSUMED
            : token.status === "revoked"
              ? CONSENT_REASON.TOKEN_REVOKED
              : CONSENT_REASON.TOKEN_EXPIRED;
        wal.append({
          type: "CONSENT_DENIED",
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          trustTier: input.trustTier,
          decision: "deny",
          reasonCode: reason,
          correlationId: input.correlationId ?? "",
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        return { allowed: false, reasonCode: reason };
      }
      const now = Date.now();
      if (token.expiresAt < now) {
        store.transition(input.jti, "expired");
        wal.append({
          type: "CONSENT_EXPIRED",
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          trustTier: input.trustTier,
          decision: "deny",
          reasonCode: CONSENT_REASON.TOKEN_EXPIRED,
          correlationId: input.correlationId ?? "",
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        return { allowed: false, reasonCode: CONSENT_REASON.TOKEN_EXPIRED };
      }
      if (token.tool !== input.tool) {
        wal.append({
          type: "CONSENT_DENIED",
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          trustTier: input.trustTier,
          decision: "deny",
          reasonCode: CONSENT_REASON.TOOL_MISMATCH,
          correlationId: input.correlationId ?? "",
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        return { allowed: false, reasonCode: CONSENT_REASON.TOOL_MISMATCH };
      }
      if (token.sessionKey !== input.sessionKey) {
        wal.append({
          type: "CONSENT_DENIED",
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          trustTier: input.trustTier,
          decision: "deny",
          reasonCode: CONSENT_REASON.SESSION_MISMATCH,
          correlationId: input.correlationId ?? "",
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        return { allowed: false, reasonCode: CONSENT_REASON.SESSION_MISMATCH };
      }
      if (token.contextHash !== input.contextHash) {
        wal.append({
          type: "CONSENT_DENIED",
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          trustTier: input.trustTier,
          decision: "deny",
          reasonCode: CONSENT_REASON.CONTEXT_MISMATCH,
          correlationId: input.correlationId ?? "",
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        return { allowed: false, reasonCode: CONSENT_REASON.CONTEXT_MISMATCH };
      }
      if (token.trustTier !== input.trustTier) {
        wal.append({
          type: "TIER_VIOLATION",
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          trustTier: input.trustTier,
          decision: "deny",
          reasonCode: CONSENT_REASON.TIER_VIOLATION,
          correlationId: input.correlationId ?? "",
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        return { allowed: false, reasonCode: CONSENT_REASON.TIER_VIOLATION };
      }
      if (token.policyVersion !== policyVersion) {
        wal.append({
          type: "CONSENT_DENIED",
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          trustTier: input.trustTier,
          decision: "deny",
          reasonCode: CONSENT_REASON.POLICY_VERSION_MISMATCH,
          correlationId: input.correlationId ?? "",
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        return { allowed: false, reasonCode: CONSENT_REASON.POLICY_VERSION_MISMATCH };
      }
      const consumed = store.transition(input.jti, "consumed");
      if (!consumed) {
        wal.append({
          type: "CONSENT_DENIED",
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          trustTier: input.trustTier,
          decision: "deny",
          reasonCode: CONSENT_REASON.TOKEN_ALREADY_CONSUMED,
          correlationId: input.correlationId ?? "",
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        return { allowed: false, reasonCode: CONSENT_REASON.TOKEN_ALREADY_CONSUMED };
      }
      wal.append({
        type: "CONSENT_CONSUMED",
        jti: input.jti,
        tool: input.tool,
        sessionKey: input.sessionKey,
        trustTier: input.trustTier,
        decision: "allow",
        reasonCode: CONSENT_REASON.ALLOWED,
        correlationId: input.correlationId ?? "",
        actor: input.actor ?? {},
        tenantId: input.tenantId ?? "",
      });
      return { allowed: true };
    },

    async revoke(input: ConsentRevokeInput): Promise<{ revoked: number }> {
      return bulkRevokeInternal(store, wal, input);
    },

    async bulkRevoke(input: ConsentRevokeInput): Promise<{ revoked: number }> {
      return bulkRevokeInternal(store, wal, input);
    },

    async status(query: ConsentStatusQuery): Promise<ConsentStatusSnapshot> {
      const tokens = query.sessionKey
        ? store.findBySession(query.sessionKey, query.tenantId)
        : [];
      const recentEvents: ConsentStatusSnapshot["recentEvents"] = [];
      // In-memory WAL may expose getEvents; if not, snapshot is minimal.
      const walWithGet = wal as WalWriter & { getEvents?(): unknown[] };
      if (typeof walWithGet.getEvents === "function") {
        const all = walWithGet.getEvents();
        const since = query.sinceMs ?? 0;
        const limit = query.limit ?? 100;
        for (let i = all.length - 1; i >= 0 && recentEvents.length < limit; i--) {
          const e = all[i] as { ts: number; sessionKey?: string; tenantId?: string };
          if (e.ts < since) continue;
          if (query.sessionKey && e.sessionKey !== query.sessionKey) continue;
          if (query.tenantId != null && e.tenantId !== query.tenantId) continue;
          recentEvents.unshift(e as ConsentStatusSnapshot["recentEvents"][0]);
        }
      }
      return {
        tokens: tokens.map((t) => ({
          jti: t.jti,
          status: t.status,
          tool: t.tool,
          sessionKey: t.sessionKey,
          issuedAt: t.issuedAt,
          expiresAt: t.expiresAt,
        })),
        recentEvents,
      };
    },
  };
}

/** Evaluate only: same checks as consume, write WAL, but do not transition token state. */
async function evaluateOnly(
  store: TokenStore,
  wal: WalWriter,
  policyVersion: string,
  quarantine: Set<string> | undefined,
  input: ConsentConsumeInput,
): Promise<ConsentConsumeResult> {
  const isQuarantined = (sessionKey: string, tenantId?: string): boolean => {
    if (!quarantine?.size) return false;
    return quarantine.has(sessionKey) || (tenantId != null && tenantId !== "" && quarantine.has(tenantId));
  };
  if (isQuarantined(input.sessionKey, input.tenantId)) {
    wal.append({
      type: "CONTAINMENT_QUARANTINE",
      jti: input.jti || null,
      tool: input.tool,
      sessionKey: input.sessionKey,
      trustTier: input.trustTier,
      decision: "deny",
      reasonCode: CONSENT_REASON.CONTAINMENT_QUARANTINE,
      correlationId: input.correlationId ?? "",
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return { allowed: false, reasonCode: CONSENT_REASON.CONTAINMENT_QUARANTINE };
  }
  if (!input.jti) {
    wal.append({
      type: "CONSENT_DENIED",
      jti: null,
      tool: input.tool,
      sessionKey: input.sessionKey,
      trustTier: input.trustTier,
      decision: "deny",
      reasonCode: CONSENT_REASON.NO_TOKEN,
      correlationId: input.correlationId ?? "",
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return { allowed: false, reasonCode: CONSENT_REASON.NO_TOKEN };
  }
  const token = store.get(input.jti);
  if (!token) {
    wal.append({
      type: "CONSENT_DENIED",
      jti: input.jti,
      tool: input.tool,
      sessionKey: input.sessionKey,
      trustTier: input.trustTier,
      decision: "deny",
      reasonCode: CONSENT_REASON.TOKEN_NOT_FOUND,
      correlationId: input.correlationId ?? "",
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return { allowed: false, reasonCode: CONSENT_REASON.TOKEN_NOT_FOUND };
  }
  if (token.status !== "issued") {
    const reason =
      token.status === "consumed"
        ? CONSENT_REASON.TOKEN_ALREADY_CONSUMED
        : token.status === "revoked"
          ? CONSENT_REASON.TOKEN_REVOKED
          : CONSENT_REASON.TOKEN_EXPIRED;
    wal.append({
      type: "CONSENT_DENIED",
      jti: input.jti,
      tool: input.tool,
      sessionKey: input.sessionKey,
      trustTier: input.trustTier,
      decision: "deny",
      reasonCode: reason,
      correlationId: input.correlationId ?? "",
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return { allowed: false, reasonCode: reason };
  }
  const now = Date.now();
  if (token.expiresAt < now) {
    wal.append({
      type: "CONSENT_EXPIRED",
      jti: input.jti,
      tool: input.tool,
      sessionKey: input.sessionKey,
      trustTier: input.trustTier,
      decision: "deny",
      reasonCode: CONSENT_REASON.TOKEN_EXPIRED,
      correlationId: input.correlationId ?? "",
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return { allowed: false, reasonCode: CONSENT_REASON.TOKEN_EXPIRED };
  }
  if (token.tool !== input.tool) {
    wal.append({
      type: "CONSENT_DENIED",
      jti: input.jti,
      tool: input.tool,
      sessionKey: input.sessionKey,
      trustTier: input.trustTier,
      decision: "deny",
      reasonCode: CONSENT_REASON.TOOL_MISMATCH,
      correlationId: input.correlationId ?? "",
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return { allowed: false, reasonCode: CONSENT_REASON.TOOL_MISMATCH };
  }
  if (token.sessionKey !== input.sessionKey) {
    wal.append({
      type: "CONSENT_DENIED",
      jti: input.jti,
      tool: input.tool,
      sessionKey: input.sessionKey,
      trustTier: input.trustTier,
      decision: "deny",
      reasonCode: CONSENT_REASON.SESSION_MISMATCH,
      correlationId: input.correlationId ?? "",
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return { allowed: false, reasonCode: CONSENT_REASON.SESSION_MISMATCH };
  }
  if (token.contextHash !== input.contextHash) {
    wal.append({
      type: "CONSENT_DENIED",
      jti: input.jti,
      tool: input.tool,
      sessionKey: input.sessionKey,
      trustTier: input.trustTier,
      decision: "deny",
      reasonCode: CONSENT_REASON.CONTEXT_MISMATCH,
      correlationId: input.correlationId ?? "",
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return { allowed: false, reasonCode: CONSENT_REASON.CONTEXT_MISMATCH };
  }
  if (token.trustTier !== input.trustTier) {
    wal.append({
      type: "TIER_VIOLATION",
      jti: input.jti,
      tool: input.tool,
      sessionKey: input.sessionKey,
      trustTier: input.trustTier,
      decision: "deny",
      reasonCode: CONSENT_REASON.TIER_VIOLATION,
      correlationId: input.correlationId ?? "",
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return { allowed: false, reasonCode: CONSENT_REASON.TIER_VIOLATION };
  }
  if (token.policyVersion !== policyVersion) {
    wal.append({
      type: "CONSENT_DENIED",
      jti: input.jti,
      tool: input.tool,
      sessionKey: input.sessionKey,
      trustTier: input.trustTier,
      decision: "deny",
      reasonCode: CONSENT_REASON.POLICY_VERSION_MISMATCH,
      correlationId: input.correlationId ?? "",
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return { allowed: false, reasonCode: CONSENT_REASON.POLICY_VERSION_MISMATCH };
  }
  wal.append({
    type: "CONSENT_CONSUMED",
    jti: input.jti,
    tool: input.tool,
    sessionKey: input.sessionKey,
    trustTier: input.trustTier,
    decision: "allow",
    reasonCode: CONSENT_REASON.ALLOWED,
    correlationId: input.correlationId ?? "",
    actor: input.actor ?? {},
    tenantId: input.tenantId ?? "",
  });
  return { allowed: true };
}

function bulkRevokeInternal(
  store: TokenStore,
  wal: WalWriter,
  input: ConsentRevokeInput,
): Promise<{ revoked: number }> {
  let revoked = 0;
  if (input.jti) {
    const token = store.get(input.jti);
    if (token && store.transition(input.jti, "revoked")) {
      revoked++;
      wal.append({
        type: "CONSENT_REVOKED",
        jti: input.jti,
        tool: token.tool,
        sessionKey: token.sessionKey,
        trustTier: token.trustTier,
        decision: "deny",
        reasonCode: "CONSENT_REVOKED",
        correlationId: input.correlationId ?? "",
        actor: {},
        tenantId: token.tenantId ?? "",
      });
    }
  } else if (input.sessionKey) {
    const tokens = store.findBySession(input.sessionKey, input.tenantId);
    for (const t of tokens) {
      if (t.status === "issued" && store.transition(t.jti, "revoked")) {
        revoked++;
        wal.append({
          type: "CONSENT_REVOKED",
          jti: t.jti,
          tool: t.tool,
          sessionKey: t.sessionKey,
          trustTier: t.trustTier,
          decision: "deny",
          reasonCode: "CASCADE_REVOKE",
          correlationId: input.correlationId ?? "",
          actor: {},
          tenantId: t.tenantId ?? "",
        });
      }
    }
  }
  return Promise.resolve({ revoked });
}
