import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { applyOagConfigChanges } from "./oag-config-writer.js";
import {
  resolveOagDeliveryMaxRetries,
  resolveOagDeliveryRecoveryBudgetMs,
  resolveOagEvolutionCooldownMs,
  resolveOagEvolutionMaxCumulativePercent,
  resolveOagEvolutionMaxNotificationsPerDay,
  resolveOagEvolutionMaxStepPercent,
  resolveOagEvolutionMinCrashesForAnalysis,
  resolveOagEvolutionPeriodicAnalysisIntervalMs,
  resolveOagLockStaleMs,
  resolveOagStalePollFactor,
} from "./oag-config.js";
import { requestDiagnosis } from "./oag-diagnosis.js";
import { emitOagEvent } from "./oag-event-bus.js";
import { startEvolutionObservation } from "./oag-evolution-guard.js";
import { injectEvolutionNote } from "./oag-evolution-notify.js";
import { collectActiveIncidents } from "./oag-incident-collector.js";
import {
  type MetricSnapshot,
  type OagIncident,
  type OagMemory,
  type SentinelContext,
  appendAuditEntry,
  findRecurringIncidentPattern,
  getRecentCrashes,
  loadOagMemory,
  recordEvolution,
  recordLifecycleShutdown,
} from "./oag-memory.js";
import { getOagMetrics } from "./oag-metrics.js";
import { type IdleCheck, runWhenIdle } from "./oag-scheduler.js";

const log = createSubsystemLogger("oag/postmortem");

// Non-configurable safety rails
const NOTIFICATION_WINDOW_MS = 24 * 60 * 60_000;
const MIN_PATTERN_OCCURRENCES = 3;
const ANALYSIS_WINDOW_HOURS = 48;
// Trend analysis compares the last 6h window against the previous 6h
const TREND_WINDOW_HOURS = 6;

export type TrendDirection = "increasing" | "decreasing" | "stable";

export type MetricTrend = {
  metric: string;
  direction: TrendDirection;
  changePercent: number;
};

export type TrendAnalysis = MetricTrend[];

/**
 * Compare the last 6 hours vs the previous 6 hours for each metric
 * to detect significant changes in trend direction.
 */
export function analyzeMetricTrends(series: MetricSnapshot[]): TrendAnalysis {
  if (series.length < 2) {
    return [];
  }

  const now = Date.now();
  const recentCutoff = now - TREND_WINDOW_HOURS * 60 * 60_000;
  const previousCutoff = now - TREND_WINDOW_HOURS * 2 * 60 * 60_000;

  const recent = series.filter((s) => Date.parse(s.timestamp) >= recentCutoff);
  const previous = series.filter((s) => {
    const ts = Date.parse(s.timestamp);
    return ts >= previousCutoff && ts < recentCutoff;
  });

  if (recent.length === 0 || previous.length === 0) {
    return [];
  }

  // Collect all metric keys from both windows
  const allKeys = new Set<string>();
  for (const snap of [...recent, ...previous]) {
    for (const key of Object.keys(snap.metrics)) {
      allKeys.add(key);
    }
  }

  const trends: TrendAnalysis = [];

  for (const key of allKeys) {
    const recentSum = recent.reduce((sum, s) => sum + (s.metrics[key] ?? 0), 0);
    const previousSum = previous.reduce((sum, s) => sum + (s.metrics[key] ?? 0), 0);

    // Normalize by count to get averages for fair comparison
    const recentAvg = recentSum / recent.length;
    const previousAvg = previousSum / previous.length;

    let changePercent = 0;
    let direction: TrendDirection = "stable";

    if (previousAvg === 0 && recentAvg === 0) {
      direction = "stable";
      changePercent = 0;
    } else if (previousAvg === 0) {
      // Went from 0 to non-zero — treat as 100% increase
      direction = "increasing";
      changePercent = 100;
    } else {
      changePercent = Math.round(((recentAvg - previousAvg) / previousAvg) * 100);
      if (changePercent > 10) {
        direction = "increasing";
      } else if (changePercent < -10) {
        direction = "decreasing";
      }
    }

    trends.push({ metric: key, direction, changePercent });
  }

  return trends;
}

export type EvolutionRecommendation = {
  configPath: string;
  currentValue: number;
  suggestedValue: number;
  reason: string;
  risk: "low" | "medium" | "high";
  source: "heuristic";
  recommendationId?: string;
  diagnosisId?: string;
};

type PostmortemResult = {
  analyzed: boolean;
  crashCount: number;
  patterns: number;
  recommendations: EvolutionRecommendation[];
  applied: EvolutionRecommendation[];
  skipped: EvolutionRecommendation[];
  trends: TrendAnalysis;
  userNotification?: string;
};

function clampChange(current: number, suggested: number, cfg: OpenClawConfig): number {
  const maxCumulative = resolveOagEvolutionMaxCumulativePercent(cfg);
  const maxStep = resolveOagEvolutionMaxStepPercent(cfg);
  const maxAllowed = current * (1 + maxCumulative / 100);
  const minAllowed = current * (1 - maxStep / 100);
  return Math.max(minAllowed, Math.min(maxAllowed, suggested));
}

// Dominance threshold: when 80%+ of incidents come from a single channel,
// scope the recommendation to that channel's config namespace.
const CHANNEL_DOMINANCE_THRESHOLD = 0.8;

/**
 * Determine whether a config path should be scoped to a specific channel.
 * When 80%+ of pattern incidents originate from a single channel, the
 * recommendation targets `gateway.oag.channels.<channel>.delivery.*` instead
 * of the global `gateway.oag.delivery.*`.
 */
function resolveChannelScopedConfigPath(
  basePath: string,
  patterns: { channel?: string; incidents: OagIncident[] }[],
): string {
  const channelCounts = new Map<string, number>();
  let total = 0;
  for (const pattern of patterns) {
    for (const incident of pattern.incidents) {
      if (incident.channel) {
        channelCounts.set(incident.channel, (channelCounts.get(incident.channel) ?? 0) + 1);
      }
      total += 1;
    }
  }
  if (total === 0) {
    return basePath;
  }
  const dominant = [...channelCounts.entries()].find(
    ([, count]) => count >= total * CHANNEL_DOMINANCE_THRESHOLD,
  );
  if (dominant) {
    // Rewrite "gateway.oag.<rest>" → "gateway.oag.channels.<channel>.<rest>"
    const prefix = "gateway.oag.";
    if (basePath.startsWith(prefix)) {
      return `gateway.oag.channels.${dominant[0]}.${basePath.slice(prefix.length)}`;
    }
  }
  return basePath;
}

function analyzePatterns(
  memory: OagMemory,
  cfg: OpenClawConfig,
  sentinelContext?: SentinelContext,
): EvolutionRecommendation[] {
  const recommendations: EvolutionRecommendation[] = [];
  const patterns = findRecurringIncidentPattern(
    memory,
    ANALYSIS_WINDOW_HOURS,
    MIN_PATTERN_OCCURRENCES,
  );

  // Use sentinel channel to enrich pattern matching when available
  const sentinelChannel = sentinelContext?.channel;

  for (const pattern of patterns) {
    // Prioritize patterns matching the sentinel channel (the channel that triggered the crash)
    const channelLabel = pattern.channel ?? sentinelChannel ?? "unknown";

    switch (pattern.type) {
      case "channel_crash_loop": {
        // Frequent crash loops suggest recovery is too aggressive
        const current = resolveOagDeliveryRecoveryBudgetMs(cfg);
        const suggested = clampChange(current, Math.round(current * 1.5), cfg);
        if (suggested > current) {
          const configPath = resolveChannelScopedConfigPath(
            "gateway.oag.delivery.recoveryBudgetMs",
            [pattern],
          );
          recommendations.push({
            configPath,
            currentValue: current,
            suggestedValue: suggested,
            reason: `Channel ${channelLabel} crash-looped ${pattern.occurrences} times in ${ANALYSIS_WINDOW_HOURS}h — spreading recovery over longer window`,
            risk: "low",
            source: "heuristic",
          });
        }
        break;
      }
      case "delivery_recovery_failure": {
        const current = resolveOagDeliveryMaxRetries(cfg);
        const suggested = clampChange(current, current + 2, cfg);
        if (suggested > current) {
          const configPath = resolveChannelScopedConfigPath("gateway.oag.delivery.maxRetries", [
            pattern,
          ]);
          recommendations.push({
            configPath,
            currentValue: current,
            suggestedValue: suggested,
            reason: `Delivery recovery failed ${pattern.occurrences} times — increasing retry budget`,
            risk: "low",
            source: "heuristic",
          });
        }
        break;
      }
      case "stale_detection": {
        const current = resolveOagStalePollFactor(cfg);
        const suggested = clampChange(current, Math.round(current * 1.3), cfg);
        if (suggested > current) {
          const configPath = resolveChannelScopedConfigPath("gateway.oag.health.stalePollFactor", [
            pattern,
          ]);
          recommendations.push({
            configPath,
            currentValue: current,
            suggestedValue: suggested,
            reason: `Stale detection triggered ${pattern.occurrences} times for ${channelLabel} — relaxing threshold to reduce false positives`,
            risk: "low",
            source: "heuristic",
          });
        }
        break;
      }
      case "lock_contention": {
        const current = resolveOagLockStaleMs(cfg);
        const suggested = clampChange(current, Math.round(current * 1.5), cfg);
        if (suggested > current) {
          recommendations.push({
            configPath: "gateway.oag.lock.staleMs",
            currentValue: current,
            suggestedValue: suggested,
            reason: `Lock contention detected ${pattern.occurrences} times — increasing stale threshold`,
            risk: "low",
            source: "heuristic",
          });
        }
        break;
      }
    }
  }

  return recommendations;
}

function hasExceededNotificationLimit(memory: OagMemory, cfg: OpenClawConfig): boolean {
  const cutoff = Date.now() - NOTIFICATION_WINDOW_MS;
  const recentEvolutions = memory.evolutions.filter((e) => Date.parse(e.appliedAt) > cutoff);
  return recentEvolutions.length >= resolveOagEvolutionMaxNotificationsPerDay(cfg);
}

function shouldRunEvolution(memory: OagMemory, cfg: OpenClawConfig): boolean {
  if (memory.evolutions.length === 0) {
    return true;
  }
  const lastEvolution = memory.evolutions[memory.evolutions.length - 1];
  const lastAt = Date.parse(lastEvolution.appliedAt);
  return Date.now() - lastAt > resolveOagEvolutionCooldownMs(cfg);
}

function buildUserNotification(result: PostmortemResult): string | undefined {
  if (result.applied.length === 0 && result.recommendations.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  if (result.applied.length > 0) {
    parts.push(
      `I analyzed ${result.crashCount} recent incidents and adjusted ${result.applied.length} parameter${result.applied.length > 1 ? "s" : ""}: ${result.applied.map((r) => r.reason).join("; ")}.`,
    );
  }
  if (result.skipped.length > 0) {
    parts.push(
      `${result.skipped.length} additional recommendation${result.skipped.length > 1 ? "s" : ""} require${result.skipped.length === 1 ? "s" : ""} operator review.`,
    );
  }
  // Append trend context for metrics that are increasing significantly
  const rising = result.trends.filter((t) => t.direction === "increasing" && t.changePercent >= 50);
  if (rising.length > 0) {
    const trendDesc = rising
      .map((t) => `${t.metric} increased ${t.changePercent}% in last 6h`)
      .join("; ");
    parts.push(`Trend alert: ${trendDesc}.`);
  }
  return parts.join(" ");
}

let postmortemRunning = false;

export async function runPostRecoveryAnalysis(
  sentinelContext?: SentinelContext,
): Promise<PostmortemResult> {
  if (postmortemRunning) {
    log.info("Post-recovery: another postmortem is already running, skipping");
    return {
      analyzed: false,
      crashCount: 0,
      patterns: 0,
      recommendations: [],
      applied: [],
      skipped: [],
      trends: [],
    };
  }
  postmortemRunning = true;
  try {
    if (sentinelContext) {
      log.info(
        `Post-recovery sentinel context: channel=${sentinelContext.channel ?? "n/a"}, session=${sentinelContext.sessionKey ?? "n/a"}, reason=${sentinelContext.stopReason ?? "n/a"}`,
      );
    }
    const memory = await loadOagMemory();
    const cfg = loadConfig();
    const recentCrashes = getRecentCrashes(memory, ANALYSIS_WINDOW_HOURS);
    const trends = analyzeMetricTrends(memory.metricSeries);

    const result: PostmortemResult = {
      analyzed: false,
      crashCount: recentCrashes.length,
      patterns: 0,
      recommendations: [],
      applied: [],
      skipped: [],
      trends,
    };

    const minCrashes = resolveOagEvolutionMinCrashesForAnalysis(cfg);
    if (recentCrashes.length < minCrashes) {
      log.info(
        `Post-recovery: ${recentCrashes.length} recent crashes (below threshold ${minCrashes}), skipping analysis`,
      );
      return result;
    }

    if (!shouldRunEvolution(memory, cfg)) {
      log.info("Post-recovery: evolution cooldown active, skipping");
      return result;
    }

    result.analyzed = true;
    const recommendations = analyzePatterns(memory, cfg, sentinelContext);
    result.recommendations = recommendations;
    result.patterns = findRecurringIncidentPattern(
      memory,
      ANALYSIS_WINDOW_HOURS,
      MIN_PATTERN_OCCURRENCES,
    ).length;

    if (recommendations.length === 0) {
      log.info("Post-recovery: no actionable recommendations from pattern analysis");
      // Escalate to agent diagnosis when patterns exist but heuristics produced no recommendations
      if (result.patterns > 0) {
        const patternList = findRecurringIncidentPattern(
          memory,
          ANALYSIS_WINDOW_HOURS,
          MIN_PATTERN_OCCURRENCES,
        );
        const primary = patternList[0];
        if (primary) {
          try {
            await requestDiagnosis({
              type: "recurring_pattern",
              description: `Recurring ${primary.type} pattern (${primary.occurrences} occurrences) with no heuristic recommendation`,
              patternType: primary.type,
              channel: primary.channel,
              occurrences: primary.occurrences,
            });
            log.info(
              "Escalated to agent diagnosis — heuristic analysis found patterns but no actionable recommendations",
            );
          } catch (err) {
            log.warn(`Agent diagnosis request failed: ${String(err)}`);
          }
        }
      }
      return result;
    }

    // Apply low-risk recommendations automatically
    const applied: EvolutionRecommendation[] = [];
    const skipped: EvolutionRecommendation[] = [];

    for (const rec of recommendations) {
      if (rec.risk === "low") {
        applied.push(rec);
        log.info(
          `Post-recovery evolution: ${rec.configPath} ${rec.currentValue} → ${rec.suggestedValue} (${rec.reason})`,
        );
      } else {
        skipped.push(rec);
        log.info(
          `Post-recovery recommendation (needs review): ${rec.configPath} ${rec.currentValue} → ${rec.suggestedValue} (${rec.reason})`,
        );
      }
    }

    result.applied = applied;
    result.skipped = skipped;

    if (applied.length > 0) {
      const configChanges = applied.map((r) => ({
        configPath: r.configPath,
        value: r.suggestedValue,
      }));
      await applyOagConfigChanges(configChanges);
      for (const rec of applied) {
        emitOagEvent("evolution_applied", {
          parameter: rec.configPath,
          oldValue: rec.currentValue,
          newValue: rec.suggestedValue,
          source: "heuristic",
        });
      }
    }

    if (applied.length > 0) {
      const evolutionChanges = applied.map((r) => ({
        configPath: r.configPath,
        from: r.currentValue,
        to: r.suggestedValue,
      }));
      await recordEvolution({
        appliedAt: new Date().toISOString(),
        source: "adaptive",
        trigger: `post-recovery analysis (${recentCrashes.length} crashes in ${ANALYSIS_WINDOW_HOURS}h)`,
        changes: evolutionChanges,
        outcome: "pending",
      });
      await appendAuditEntry({
        timestamp: new Date().toISOString(),
        action: "evolution_applied",
        detail: `Adaptive evolution: ${applied.map((r) => `${r.configPath} ${r.currentValue} -> ${r.suggestedValue}`).join(", ")}`,
        changes: evolutionChanges,
      });
      // Collect recommendation IDs for tracking (from diagnosis-originated recommendations)
      const recIds = applied
        .map((r) => r.recommendationId)
        .filter((id): id is string => id !== undefined);
      const diagId = applied.find((r) => r.diagnosisId)?.diagnosisId;

      await startEvolutionObservation({
        appliedAt: new Date().toISOString(),
        rollbackChanges: applied.map((r) => ({
          configPath: r.configPath,
          previousValue: r.currentValue,
        })),
        diagnosisId: diagId,
        recommendationIds: recIds.length > 0 ? recIds : undefined,
      });
    }

    result.userNotification = buildUserNotification(result);

    if (
      result.userNotification &&
      applied.length > 0 &&
      !hasExceededNotificationLimit(memory, cfg)
    ) {
      const evolutionId = `ev-${Date.now()}`;
      await injectEvolutionNote({
        message: result.userNotification,
        evolutionId,
      });
    }

    return result;
  } finally {
    postmortemRunning = false;
  }
}

/**
 * Schedule periodic runtime analysis that runs every `intervalMs` (default 6h).
 * Each cycle records a checkpoint snapshot of current incidents, then waits for
 * an idle window before running the full postmortem analysis.
 */
export function schedulePeriodicAnalysis(opts: { idleCheck: IdleCheck; intervalMs?: number }): {
  stop: () => void;
} {
  const cfg = loadConfig();
  const intervalMs = opts.intervalMs ?? resolveOagEvolutionPeriodicAnalysisIntervalMs(cfg);

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function scheduleNext(): void {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void runPeriodicCycle();
    }, intervalMs);
  }

  async function runPeriodicCycle(): Promise<void> {
    if (stopped) {
      return;
    }
    try {
      // Record a checkpoint snapshot so the memory file has fresh incident data
      const incidents = collectActiveIncidents();
      await recordLifecycleShutdown({
        startedAt: Date.now(),
        stopReason: "checkpoint",
        metricsSnapshot: getOagMetrics(),
        incidents,
      });

      // Wait for idle window, then run analysis
      await runWhenIdle(
        async () => {
          const result = await runPostRecoveryAnalysis();
          if (result.userNotification) {
            log.info(`OAG periodic evolution: ${result.userNotification}`);
          }
          if (result.applied.length > 0) {
            log.info(
              `OAG periodic evolution applied ${result.applied.length} parameter adjustments`,
            );
          }
        },
        opts.idleCheck,
        { cfg },
      );
    } catch (err) {
      log.warn(`OAG periodic analysis failed: ${String(err)}`);
    } finally {
      scheduleNext();
    }
  }

  scheduleNext();

  return {
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
