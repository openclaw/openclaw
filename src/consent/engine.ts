/**
 * ConsentGate engine: implements ConsentGateApi using token store and WAL.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
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
import type { ConsentMetrics } from "./metrics.js";
import type { TokenStore } from "./store.js";
import type { WalWriter } from "./wal.js";
import { CONSENT_REASON, getConsentReasonMessage } from "./reason-codes.js";
import { buildToken } from "./store.js";

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const consentLog = createSubsystemLogger("consentgate");

export type ConsentEngineDeps = {
  store: TokenStore;
  wal: WalWriter;
  policyVersion: string;
  /** Optional: sessionKeys or tenantIds in this set are quarantined (no issue/consume). */
  quarantine?: Set<string>;
  /** Optional: metrics for observability. */
  metrics?: ConsentMetrics;
  /** Optional: tier -> allowed tool names. If set, issue/consume denied when tool not in list for tier. */
  tierToolMatrix?: Record<string, string[]>;
  /** Optional: sliding-window rate limit per session. */
  rateLimit?: { maxOpsPerWindow: number; windowMs: number };
};

function deny(reasonCode: string, correlationId: string): ConsentConsumeResult {
  return {
    allowed: false,
    reasonCode,
    message: getConsentReasonMessage(reasonCode),
    correlationId,
  };
}

function observe(
  metrics: ConsentMetrics | undefined,
  eventType: "issue" | "consume" | "revoke" | "deny" | "quarantine",
  payload: { jti?: string | null; tool: string; sessionKey: string; reasonCode?: string; correlationId?: string },
): void {
  if (eventType === "issue") metrics?.incrementIssue();
  else if (eventType === "consume") metrics?.incrementConsume();
  else if (eventType === "revoke") metrics?.incrementRevoke();
  else if (eventType === "quarantine") metrics?.incrementQuarantine();
  else if (eventType === "deny" && payload.reasonCode) metrics?.incrementDeny(payload.reasonCode);
  consentLog.info(JSON.stringify({ eventType, ...payload }));
}

export function createConsentEngine(deps: ConsentEngineDeps): ConsentGateApi {
  const { store, wal, policyVersion, quarantine, metrics, tierToolMatrix, rateLimit } = deps;
  const rateLimitTimestamps = new Map<string, number[]>();

  function isQuarantined(sessionKey: string, tenantId?: string): boolean {
    if (!quarantine?.size) return false;
    return quarantine.has(sessionKey) || (tenantId != null && tenantId !== "" && quarantine.has(tenantId));
  }

  function checkTierTool(trustTier: string, tool: string): boolean {
    if (!tierToolMatrix) return true;
    const allowed = tierToolMatrix[trustTier];
    if (!allowed || !Array.isArray(allowed)) return false;
    return allowed.includes(tool);
  }

  function checkRateLimit(sessionKey: string): boolean {
    if (!rateLimit || rateLimit.maxOpsPerWindow <= 0 || rateLimit.windowMs <= 0) return true;
    const now = Date.now();
    const cutoff = now - rateLimit.windowMs;
    let ts = rateLimitTimestamps.get(sessionKey) ?? [];
    ts = ts.filter((t) => t > cutoff);
    if (ts.length >= rateLimit.maxOpsPerWindow) return false;
    ts.push(now);
    rateLimitTimestamps.set(sessionKey, ts);
    return true;
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
        observe(metrics, "quarantine", {
          jti: null,
          tool: input.tool,
          sessionKey: input.sessionKey,
          reasonCode: CONSENT_REASON.CONTAINMENT_QUARANTINE,
          correlationId: input.correlationId ?? "",
        });
        return null;
      }
      if (!checkTierTool(input.trustTier, input.tool)) {
        wal.append({
          type: "TIER_VIOLATION",
          jti: null,
          tool: input.tool,
          sessionKey: input.sessionKey,
          trustTier: input.trustTier,
          decision: "deny",
          reasonCode: CONSENT_REASON.TIER_VIOLATION,
          correlationId: input.correlationId ?? "",
          actor: { issuedBy: input.issuedBy },
          tenantId: input.tenantId ?? "",
        });
        observe(metrics, "deny", {
          jti: null,
          tool: input.tool,
          sessionKey: input.sessionKey,
          reasonCode: CONSENT_REASON.TIER_VIOLATION,
          correlationId: input.correlationId ?? "",
        });
        return null;
      }
      if (!checkRateLimit(input.sessionKey)) {
        wal.append({
          type: "CONSENT_DENIED",
          jti: null,
          tool: input.tool,
          sessionKey: input.sessionKey,
          trustTier: input.trustTier,
          decision: "deny",
          reasonCode: CONSENT_REASON.RATE_LIMIT,
          correlationId: input.correlationId ?? "",
          actor: { issuedBy: input.issuedBy },
          tenantId: input.tenantId ?? "",
        });
        observe(metrics, "deny", {
          jti: null,
          tool: input.tool,
          sessionKey: input.sessionKey,
          reasonCode: CONSENT_REASON.RATE_LIMIT,
          correlationId: input.correlationId ?? "",
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
      observe(metrics, "issue", {
        jti: token.jti,
        tool: token.tool,
        sessionKey: token.sessionKey,
        correlationId: input.correlationId ?? "",
      });
      return token;
    },

    async evaluate(input: ConsentConsumeInput): Promise<ConsentConsumeResult> {
      return evaluateOnly(store, wal, policyVersion, quarantine, input);
    },

    async consume(input: ConsentConsumeInput): Promise<ConsentConsumeResult> {
      const correlationId = input.correlationId ?? "";
      if (isQuarantined(input.sessionKey, input.tenantId)) {
        wal.append({
          type: "CONTAINMENT_QUARANTINE",
          jti: input.jti || null,
          tool: input.tool,
          sessionKey: input.sessionKey,
          trustTier: input.trustTier,
          decision: "deny",
          reasonCode: CONSENT_REASON.CONTAINMENT_QUARANTINE,
          correlationId,
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        observe(metrics, "deny", {
          jti: null,
          tool: input.tool,
          sessionKey: input.sessionKey,
          reasonCode: CONSENT_REASON.CONTAINMENT_QUARANTINE,
          correlationId,
        });
        return deny(CONSENT_REASON.CONTAINMENT_QUARANTINE, correlationId);
      }
      if (!checkTierTool(input.trustTier, input.tool)) {
        wal.append({
          type: "TIER_VIOLATION",
          jti: input.jti ?? null,
          tool: input.tool,
          sessionKey: input.sessionKey,
          trustTier: input.trustTier,
          decision: "deny",
          reasonCode: CONSENT_REASON.TIER_VIOLATION,
          correlationId,
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        observe(metrics, "deny", {
          jti: input.jti ?? null,
          tool: input.tool,
          sessionKey: input.sessionKey,
          reasonCode: CONSENT_REASON.TIER_VIOLATION,
          correlationId,
        });
        return deny(CONSENT_REASON.TIER_VIOLATION, correlationId);
      }
      if (!checkRateLimit(input.sessionKey)) {
        wal.append({
          type: "CONSENT_DENIED",
          jti: input.jti ?? null,
          tool: input.tool,
          sessionKey: input.sessionKey,
          trustTier: input.trustTier,
          decision: "deny",
          reasonCode: CONSENT_REASON.RATE_LIMIT,
          correlationId,
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        observe(metrics, "deny", {
          jti: input.jti ?? null,
          tool: input.tool,
          sessionKey: input.sessionKey,
          reasonCode: CONSENT_REASON.RATE_LIMIT,
          correlationId,
        });
        return deny(CONSENT_REASON.RATE_LIMIT, correlationId);
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
          correlationId,
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        observe(metrics, "deny", {
          jti: null,
          tool: input.tool,
          sessionKey: input.sessionKey,
          reasonCode: CONSENT_REASON.NO_TOKEN,
          correlationId,
        });
        return deny(CONSENT_REASON.NO_TOKEN, correlationId);
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
          correlationId,
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        observe(metrics, "deny", {
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          reasonCode: CONSENT_REASON.TOKEN_NOT_FOUND,
          correlationId,
        });
        return deny(CONSENT_REASON.TOKEN_NOT_FOUND, correlationId);
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
          correlationId,
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        observe(metrics, "deny", {
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          reasonCode: reason,
          correlationId,
        });
        return deny(reason, correlationId);
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
          correlationId,
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        observe(metrics, "deny", {
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          reasonCode: CONSENT_REASON.TOKEN_EXPIRED,
          correlationId,
        });
        return deny(CONSENT_REASON.TOKEN_EXPIRED, correlationId);
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
          correlationId,
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        observe(metrics, "deny", {
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          reasonCode: CONSENT_REASON.TOOL_MISMATCH,
          correlationId,
        });
        return deny(CONSENT_REASON.TOOL_MISMATCH, correlationId);
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
          correlationId,
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        observe(metrics, "deny", {
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          reasonCode: CONSENT_REASON.SESSION_MISMATCH,
          correlationId,
        });
        return deny(CONSENT_REASON.SESSION_MISMATCH, correlationId);
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
          correlationId,
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        observe(metrics, "deny", {
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          reasonCode: CONSENT_REASON.CONTEXT_MISMATCH,
          correlationId,
        });
        return deny(CONSENT_REASON.CONTEXT_MISMATCH, correlationId);
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
          correlationId,
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        observe(metrics, "deny", {
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          reasonCode: CONSENT_REASON.TIER_VIOLATION,
          correlationId,
        });
        return deny(CONSENT_REASON.TIER_VIOLATION, correlationId);
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
          correlationId,
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        observe(metrics, "deny", {
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          reasonCode: CONSENT_REASON.POLICY_VERSION_MISMATCH,
          correlationId,
        });
        return deny(CONSENT_REASON.POLICY_VERSION_MISMATCH, correlationId);
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
          correlationId,
          actor: input.actor ?? {},
          tenantId: input.tenantId ?? "",
        });
        observe(metrics, "deny", {
          jti: input.jti,
          tool: input.tool,
          sessionKey: input.sessionKey,
          reasonCode: CONSENT_REASON.TOKEN_ALREADY_CONSUMED,
          correlationId,
        });
        return deny(CONSENT_REASON.TOKEN_ALREADY_CONSUMED, correlationId);
      }
      wal.append({
        type: "CONSENT_CONSUMED",
        jti: input.jti,
        tool: input.tool,
        sessionKey: input.sessionKey,
        trustTier: input.trustTier,
        decision: "allow",
        reasonCode: CONSENT_REASON.ALLOWED,
        correlationId,
        actor: input.actor ?? {},
        tenantId: input.tenantId ?? "",
      });
      observe(metrics, "consume", {
        jti: input.jti,
        tool: input.tool,
        sessionKey: input.sessionKey,
        correlationId,
      });
      return { allowed: true };
    },

    async revoke(input: ConsentRevokeInput): Promise<{ revoked: number }> {
      return bulkRevokeInternal(store, wal, input, metrics);
    },

    async bulkRevoke(input: ConsentRevokeInput): Promise<{ revoked: number }> {
      return bulkRevokeInternal(store, wal, input, metrics);
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
        quarantinedSessionKeys: quarantine ? Array.from(quarantine) : [],
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
  const correlationId = input.correlationId ?? "";
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
      correlationId,
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return deny(CONSENT_REASON.CONTAINMENT_QUARANTINE, correlationId);
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
      correlationId,
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return deny(CONSENT_REASON.NO_TOKEN, correlationId);
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
      correlationId,
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return deny(CONSENT_REASON.TOKEN_NOT_FOUND, correlationId);
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
      correlationId,
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return deny(reason, correlationId);
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
      correlationId,
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return deny(CONSENT_REASON.TOKEN_EXPIRED, correlationId);
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
      correlationId,
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return deny(CONSENT_REASON.TOOL_MISMATCH, correlationId);
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
      correlationId,
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return deny(CONSENT_REASON.SESSION_MISMATCH, correlationId);
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
      correlationId,
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return deny(CONSENT_REASON.CONTEXT_MISMATCH, correlationId);
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
      correlationId,
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return deny(CONSENT_REASON.TIER_VIOLATION, correlationId);
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
      correlationId,
      actor: input.actor ?? {},
      tenantId: input.tenantId ?? "",
    });
    return deny(CONSENT_REASON.POLICY_VERSION_MISMATCH, correlationId);
  }
  wal.append({
    type: "CONSENT_EVALUATED",
    jti: input.jti,
    tool: input.tool,
    sessionKey: input.sessionKey,
    trustTier: input.trustTier,
    decision: "allow",
    reasonCode: CONSENT_REASON.ALLOWED,
    correlationId,
    actor: input.actor ?? {},
    tenantId: input.tenantId ?? "",
  });
  return { allowed: true };
}

function bulkRevokeInternal(
  store: TokenStore,
  wal: WalWriter,
  input: ConsentRevokeInput,
  metrics?: ConsentMetrics,
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
        reasonCode: CONSENT_REASON.TOKEN_REVOKED,
        correlationId: input.correlationId ?? "",
        actor: {},
        tenantId: token.tenantId ?? "",
      });
      observe(metrics, "revoke", {
        jti: input.jti,
        tool: token.tool,
        sessionKey: token.sessionKey,
        correlationId: input.correlationId ?? "",
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
          reasonCode: CONSENT_REASON.TOKEN_REVOKED,
          correlationId: input.correlationId ?? "",
          actor: {},
          tenantId: t.tenantId ?? "",
        });
        observe(metrics, "revoke", {
          jti: t.jti,
          tool: t.tool,
          sessionKey: t.sessionKey,
          correlationId: input.correlationId ?? "",
        });
      }
    }
  }
  return Promise.resolve({ revoked });
}
