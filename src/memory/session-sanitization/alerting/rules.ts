import crypto from "node:crypto";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { AlertPayload, AlertSeverity, AuditEventRecord } from "../types.js";
import type { ResolvedAlertingConfig } from "./config.js";
import { queryIndex } from "./state.js";

const log = createSubsystemLogger("memory/session-sanitization/alerting/rules");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build a stable, short alert ID from rule + agent + session + time bucket. */
function makeAlertId(
  ruleId: string,
  agentId: string,
  sessionId: string | null,
  now: number,
): string {
  const raw = `${ruleId}:${agentId}:${sessionId ?? "cross"}:${Math.floor(now / 60_000)}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/** Common type for all rule evaluators. */
export type RuleEvaluator = (params: {
  entry: AuditEventRecord;
  cfg: ResolvedAlertingConfig;
  recentContext: AuditEventRecord[];
  now: number;
}) => AlertPayload | null;

// ---------------------------------------------------------------------------
// Rule: syntacticFailBurst
//
// Fires when N syntactic_fail events occur within a sliding window across
// sessions for the same agent — indicates a sustained injection pattern or
// fuzzing attempt.
// ---------------------------------------------------------------------------

export const evaluateSyntacticFailBurst: RuleEvaluator = ({ entry, cfg, recentContext, now }) => {
  if (entry.event !== "syntactic_fail") return null;

  const rule = cfg.rules.syntacticFailBurst;
  // Cross-session: count syntactic_fail across ALL sessions for this agent
  const recent = queryIndex({
    event: "syntactic_fail",
    agentId: entry.agentId,
    windowMs: rule.windowMs,
    now,
  });

  if (recent.length < rule.count) return null;

  const severity: AlertSeverity = recent.length >= rule.count * 2 ? "high" : "medium";
  return {
    alertId: makeAlertId("syntacticFailBurst", entry.agentId, null, now),
    ruleId: "syntacticFailBurst",
    severity,
    agentId: entry.agentId,
    sessionId: null,
    timestamp: new Date(now).toISOString(),
    summary: `${recent.length} syntactic_fail events in ${rule.windowMs / 60_000}min window (threshold ${rule.count})`,
    details: {
      triggeringEvents: recent,
      recentContext,
    },
    metadata: { ruleConfig: { count: rule.count, windowMs: rule.windowMs } },
  };
};

// ---------------------------------------------------------------------------
// Rule: trustedToolSchemaFail
//
// Fires when schema_fail is observed for a server listed in trustedServers.
// This signals a trust misconfiguration — a server declared trusted is
// producing output that fails structural validation.
// ---------------------------------------------------------------------------

export const evaluateTrustedToolSchemaFail: RuleEvaluator = ({
  entry,
  cfg,
  recentContext,
  now,
}) => {
  if (!cfg.rules.trustedToolSchemaFail.enabled) return null;
  if (entry.event !== "schema_fail") return null;

  const server = entry.server;
  if (!server || !cfg.trustedServers.includes(server)) return null;

  return {
    alertId: makeAlertId("trustedToolSchemaFail", entry.agentId, entry.sessionId, now),
    ruleId: "trustedToolSchemaFail",
    severity: "high",
    agentId: entry.agentId,
    sessionId: entry.sessionId,
    timestamp: new Date(now).toISOString(),
    summary: `Schema validation failure on declared-trusted server "${server}"`,
    details: {
      triggeringEvents: [entry],
      recentContext,
    },
    metadata: { ruleConfig: {} },
  };
};

// ---------------------------------------------------------------------------
// Rule: frequencyEscalation
//
// Fires on frequency_escalation_tier2 (if enabled) or tier3 (always enabled).
// Tier 3 escalation (session termination) is always critical — it cannot be
// disabled via config.
// ---------------------------------------------------------------------------

export const evaluateFrequencyEscalation: RuleEvaluator = ({ entry, cfg, recentContext, now }) => {
  if (entry.event === "frequency_escalation_tier2" && !cfg.rules.frequencyEscalation.tier2) {
    return null;
  }
  if (
    entry.event !== "frequency_escalation_tier2" &&
    entry.event !== "frequency_escalation_tier3"
  ) {
    return null;
  }

  const isTier3 = entry.event === "frequency_escalation_tier3";
  const severity: AlertSeverity = isTier3 ? "critical" : "high";
  const tierLabel = isTier3 ? "3" : "2";

  return {
    alertId: makeAlertId("frequencyEscalation", entry.agentId, entry.sessionId, now),
    ruleId: "frequencyEscalation",
    severity,
    agentId: entry.agentId,
    sessionId: entry.sessionId,
    timestamp: new Date(now).toISOString(),
    summary: `Frequency escalation tier ${tierLabel} — suspicion score ${entry.currentScore?.toFixed(1) ?? "?"}`,
    details: {
      triggeringEvents: [entry],
      recentContext,
      sessionSuspicionScore: entry.currentScore,
    },
    metadata: { ruleConfig: {} },
  };
};

// ---------------------------------------------------------------------------
// Rule: semanticCatchNoSyntacticFlag
//
// Fires when Tier 2 (semantic sub-agent) produces a sanitized_block but the
// same tool call had no prior syntactic_fail — meaning Tier 1 completely
// missed the threat. Indicates a novel or indirect injection pattern.
//
// Severity escalates to "high" after `escalateAfter` occurrences in 24 hours.
// ---------------------------------------------------------------------------

const SEMANTIC_CATCH_24H_MS = 24 * 60 * 60 * 1000;

export const evaluateSemanticCatch: RuleEvaluator = ({ entry, cfg, recentContext, now }) => {
  if (!cfg.rules.semanticCatchNoSyntacticFlag.enabled) return null;
  if (entry.event !== "sanitized_block") return null;
  if (entry.tier !== 2) return null;

  // Correlate with syntactic_pass (no flags) using messageId (primary) or
  // toolCallId (fallback). The rule fires only when there is a confirmed
  // syntactic_pass — meaning Tier 1 ran and found nothing, but Tier 2 caught
  // something. If we cannot correlate or there is no syntactic_pass, skip.
  let hadSyntacticPass: boolean;
  if (entry.messageId) {
    hadSyntacticPass = recentContext.some(
      (e) => e.event === "syntactic_pass" && e.messageId === entry.messageId,
    );
  } else if (entry.toolCallId) {
    hadSyntacticPass = recentContext.some(
      (e) => e.event === "syntactic_pass" && e.toolCallId === entry.toolCallId,
    );
  } else {
    log.warn("alerting: Rule 4 — messageId and toolCallId both null, skipping correlation", {
      agentId: entry.agentId,
      sessionId: entry.sessionId,
    });
    return null;
  }
  // Only trigger when syntactic explicitly passed — confirms Tier 1 missed the threat.
  if (!hadSyntacticPass) return null;

  // Count prior Tier 2 semantic catches in the last 24h for severity escalation
  const prior24h = queryIndex({
    event: "sanitized_block",
    agentId: entry.agentId,
    windowMs: SEMANTIC_CATCH_24H_MS,
    now,
  }).filter((e) => e.tier === 2);

  const severity: AlertSeverity =
    prior24h.length >= cfg.rules.semanticCatchNoSyntacticFlag.escalateAfter ? "high" : "medium";

  return {
    alertId: makeAlertId("semanticCatch", entry.agentId, entry.sessionId, now),
    ruleId: "semanticCatchNoSyntacticFlag",
    severity,
    agentId: entry.agentId,
    sessionId: entry.sessionId,
    timestamp: new Date(now).toISOString(),
    summary: `Tier 2 semantic block with no prior Tier 1 warning — novel or indirect attack pattern`,
    details: {
      triggeringEvents: [entry],
      recentContext,
    },
    metadata: {
      ruleConfig: { escalateAfter: cfg.rules.semanticCatchNoSyntacticFlag.escalateAfter },
    },
  };
};

// ---------------------------------------------------------------------------
// Rule: writeFailSpike
//
// Fires when N write_failed events occur within a sliding window — indicates
// repeated helper errors (sub-agent crash loop, storage failure, etc.).
// ---------------------------------------------------------------------------

export const evaluateWriteFailSpike: RuleEvaluator = ({ entry, cfg, recentContext, now }) => {
  if (entry.event !== "write_failed") return null;

  const rule = cfg.rules.writeFailSpike;
  // Cross-session: count write_failed across ALL sessions for this agent
  const recent = queryIndex({
    event: "write_failed",
    agentId: entry.agentId,
    windowMs: rule.windowMs,
    now,
  });

  if (recent.length < rule.count) return null;

  return {
    alertId: makeAlertId("writeFailSpike", entry.agentId, null, now),
    ruleId: "writeFailSpike",
    severity: "medium",
    agentId: entry.agentId,
    sessionId: null,
    timestamp: new Date(now).toISOString(),
    summary: `${recent.length} write_failed events in ${rule.windowMs / 60_000}min window (threshold ${rule.count})`,
    details: {
      triggeringEvents: recent,
      recentContext,
    },
    metadata: { ruleConfig: { count: rule.count, windowMs: rule.windowMs } },
  };
};

/**
 * Ordered list of all rule evaluators.
 *
 * Note: signal_failed events are routed through gatedAudit with alertDeps, so
 * notifyAlerting fires — but no rule here evaluates them. Signal failures are
 * transient infrastructure errors (model API instability, recall helper timeouts)
 * rather than security signals. If repeated signal failures warrant operator
 * alerting, add a Rule 6 here.
 */
export const ALL_RULES: RuleEvaluator[] = [
  evaluateSyntacticFailBurst,
  evaluateTrustedToolSchemaFail,
  evaluateFrequencyEscalation,
  evaluateSemanticCatch,
  evaluateWriteFailSpike,
];
