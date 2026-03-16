import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { applyOagConfigChanges } from "./oag-config-writer.js";
import {
  resolveOagDeliveryMaxRetries,
  resolveOagDeliveryRecoveryBudgetMs,
  resolveOagLockStaleMs,
  resolveOagStalePollFactor,
} from "./oag-config.js";
import { startEvolutionObservation } from "./oag-evolution-guard.js";
import { injectEvolutionNote } from "./oag-evolution-notify.js";
import {
  type OagMemory,
  findRecurringIncidentPattern,
  getRecentCrashes,
  loadOagMemory,
  recordEvolution,
} from "./oag-memory.js";

const log = createSubsystemLogger("oag/postmortem");

// Safety rails
const MAX_STEP_PERCENT = 50;
const MAX_CUMULATIVE_PERCENT = 200;
const MIN_CRASHES_FOR_ANALYSIS = 2;
const MIN_PATTERN_OCCURRENCES = 3;
const ANALYSIS_WINDOW_HOURS = 48;
const COOLDOWN_BETWEEN_EVOLUTIONS_MS = 4 * 60 * 60_000;

export type EvolutionRecommendation = {
  configPath: string;
  currentValue: number;
  suggestedValue: number;
  reason: string;
  risk: "low" | "medium" | "high";
  source: "heuristic";
};

type PostmortemResult = {
  analyzed: boolean;
  crashCount: number;
  patterns: number;
  recommendations: EvolutionRecommendation[];
  applied: EvolutionRecommendation[];
  skipped: EvolutionRecommendation[];
  userNotification?: string;
};

function clampChange(current: number, suggested: number): number {
  const maxAllowed = current * (1 + MAX_CUMULATIVE_PERCENT / 100);
  const minAllowed = current * (1 - MAX_STEP_PERCENT / 100);
  return Math.max(minAllowed, Math.min(maxAllowed, suggested));
}

function analyzePatterns(memory: OagMemory, cfg: OpenClawConfig): EvolutionRecommendation[] {
  const recommendations: EvolutionRecommendation[] = [];
  const patterns = findRecurringIncidentPattern(
    memory,
    ANALYSIS_WINDOW_HOURS,
    MIN_PATTERN_OCCURRENCES,
  );

  for (const pattern of patterns) {
    switch (pattern.type) {
      case "channel_crash_loop": {
        // Frequent crash loops suggest recovery is too aggressive
        const current = resolveOagDeliveryRecoveryBudgetMs(cfg);
        const suggested = clampChange(current, Math.round(current * 1.5));
        if (suggested > current) {
          recommendations.push({
            configPath: "gateway.oag.delivery.recoveryBudgetMs",
            currentValue: current,
            suggestedValue: suggested,
            reason: `Channel ${pattern.channel ?? "unknown"} crash-looped ${pattern.occurrences} times in ${ANALYSIS_WINDOW_HOURS}h — spreading recovery over longer window`,
            risk: "low",
            source: "heuristic",
          });
        }
        break;
      }
      case "delivery_recovery_failure": {
        const current = resolveOagDeliveryMaxRetries(cfg);
        const suggested = clampChange(current, current + 2);
        if (suggested > current) {
          recommendations.push({
            configPath: "gateway.oag.delivery.maxRetries",
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
        const suggested = clampChange(current, Math.round(current * 1.3));
        if (suggested > current) {
          recommendations.push({
            configPath: "gateway.oag.health.stalePollFactor",
            currentValue: current,
            suggestedValue: suggested,
            reason: `Stale detection triggered ${pattern.occurrences} times for ${pattern.channel ?? "unknown"} — relaxing threshold to reduce false positives`,
            risk: "low",
            source: "heuristic",
          });
        }
        break;
      }
      case "lock_contention": {
        const current = resolveOagLockStaleMs(cfg);
        const suggested = clampChange(current, Math.round(current * 1.5));
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

function shouldRunEvolution(memory: OagMemory): boolean {
  if (memory.evolutions.length === 0) {
    return true;
  }
  const lastEvolution = memory.evolutions[memory.evolutions.length - 1];
  const lastAt = Date.parse(lastEvolution.appliedAt);
  return Date.now() - lastAt > COOLDOWN_BETWEEN_EVOLUTIONS_MS;
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
  return parts.join(" ");
}

export async function runPostRecoveryAnalysis(): Promise<PostmortemResult> {
  const memory = await loadOagMemory();
  const cfg = loadConfig();
  const recentCrashes = getRecentCrashes(memory, ANALYSIS_WINDOW_HOURS);

  const result: PostmortemResult = {
    analyzed: false,
    crashCount: recentCrashes.length,
    patterns: 0,
    recommendations: [],
    applied: [],
    skipped: [],
  };

  if (recentCrashes.length < MIN_CRASHES_FOR_ANALYSIS) {
    log.info(
      `Post-recovery: ${recentCrashes.length} recent crashes (below threshold ${MIN_CRASHES_FOR_ANALYSIS}), skipping analysis`,
    );
    return result;
  }

  if (!shouldRunEvolution(memory)) {
    log.info("Post-recovery: evolution cooldown active, skipping");
    return result;
  }

  result.analyzed = true;
  const recommendations = analyzePatterns(memory, cfg);
  result.recommendations = recommendations;
  result.patterns = findRecurringIncidentPattern(
    memory,
    ANALYSIS_WINDOW_HOURS,
    MIN_PATTERN_OCCURRENCES,
  ).length;

  if (recommendations.length === 0) {
    log.info("Post-recovery: no actionable recommendations from pattern analysis");
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
  }

  if (applied.length > 0) {
    await recordEvolution({
      appliedAt: new Date().toISOString(),
      source: "adaptive",
      trigger: `post-recovery analysis (${recentCrashes.length} crashes in ${ANALYSIS_WINDOW_HOURS}h)`,
      changes: applied.map((r) => ({
        configPath: r.configPath,
        from: r.currentValue,
        to: r.suggestedValue,
      })),
      outcome: "pending",
    });
    await startEvolutionObservation({
      appliedAt: new Date().toISOString(),
      rollbackChanges: applied.map((r) => ({
        configPath: r.configPath,
        previousValue: r.currentValue,
      })),
    });
  }

  result.userNotification = buildUserNotification(result);

  if (result.userNotification && applied.length > 0) {
    const evolutionId = `ev-${Date.now()}`;
    await injectEvolutionNote({
      message: result.userNotification,
      evolutionId,
    });
  }

  return result;
}
