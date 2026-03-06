import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { AlertPayload, AuditEventRecord, SessionMemoryAuditEntry } from "../types.js";
import { resolveAlertingConfig } from "./config.js";
import { ALL_RULES } from "./rules.js";
import {
  addToIndex,
  buildDedupKey,
  getDailySummary,
  incrementDailyCount,
  isDeduped,
  isRateLimited,
  queryIndex,
  recordDelivery,
  recordFired,
  sweepIndex,
} from "./state.js";
import { deliverWebhook } from "./webhook.js";

export { getDailySummary, resetAlertingState } from "./state.js";

const log = createSubsystemLogger("memory/session-sanitization/alerting");

/**
 * Notify the alerting engine of a newly-written audit entry.
 *
 * Synchronous entry point — webhook delivery is fire-and-forget. Does not
 * block the audit path. Safe to call on every gatedAudit write.
 */
export function notifyAlerting(params: {
  entry: SessionMemoryAuditEntry;
  agentId: string;
  sessionId: string;
  cfg: OpenClawConfig | undefined;
  now: number;
}): void {
  const alertingCfg = resolveAlertingConfig(params.cfg);
  if (!alertingCfg.enabled) return;

  const record: AuditEventRecord = {
    ...params.entry,
    agentId: params.agentId,
    sessionId: params.sessionId,
  };

  // Add to cross-session index, then sweep stale entries
  addToIndex(record, params.now);
  sweepIndex(alertingCfg.index.ttlMs, params.now);

  // Build recent context: last recentContextMax events from this session
  const recentContext = queryIndex({
    agentId: params.agentId,
    sessionId: params.sessionId,
    windowMs: alertingCfg.index.ttlMs,
    now: params.now,
  }).slice(-alertingCfg.payload.recentContextMax);

  // Evaluate all rules in order
  for (const evaluate of ALL_RULES) {
    let alert: AlertPayload | null = null;
    try {
      alert = evaluate({
        entry: record,
        cfg: alertingCfg,
        recentContext,
        now: params.now,
      });
    } catch (err) {
      log.warn("alerting: rule evaluation error", {
        error: err instanceof Error ? err.message : String(err),
        agentId: params.agentId,
        event: params.entry.event,
      });
      continue;
    }

    if (!alert) continue;

    // Deduplication check
    const dedupKey = buildDedupKey(alert.ruleId, params.agentId, params.sessionId);
    if (isDeduped(dedupKey, alertingCfg.suppression.windowMs, params.now)) {
      const existingEntry = alert.metadata as { suppressedCount?: number };
      existingEntry.suppressedCount = (existingEntry.suppressedCount ?? 0) + 1;
      continue;
    }

    // Rate limit check
    if (
      isRateLimited(
        alert.ruleId,
        alertingCfg.rateLimit.maxPerMinute,
        alertingCfg.rateLimit.maxPerHour,
        params.now,
      )
    ) {
      log.warn("alerting: rate limit reached — alert suppressed", {
        ruleId: alert.ruleId,
        agentId: params.agentId,
      });
      continue;
    }

    // Record fire + delivery before async delivery to prevent double-fire
    recordFired(dedupKey, params.now);
    recordDelivery(alert.ruleId, params.now);
    incrementDailyCount(alert.ruleId, params.now);

    // Deliver webhook fire-and-forget
    deliverWebhook(alert, alertingCfg).catch((err) => {
      log.warn("alerting: webhook delivery error", {
        alertId: alert!.alertId,
        ruleId: alert!.ruleId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
