import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { applyOagConfigChanges } from "./oag-config-writer.js";
import {
  resolveOagEvolutionFailureRegressionThreshold,
  resolveOagEvolutionObservationWindowMs,
  resolveOagEvolutionRestartRegressionThreshold,
} from "./oag-config.js";
import {
  appendAuditEntry,
  loadOagMemory,
  saveOagMemory,
  updateRecommendationOutcome,
} from "./oag-memory.js";
import { getOagMetrics, type OagMetricCounters } from "./oag-metrics.js";

const log = createSubsystemLogger("oag/evolution-guard");

export type EvolutionObservation = {
  evolutionAppliedAt: string;
  baselineMetrics: Pick<
    OagMetricCounters,
    "channelRestarts" | "deliveryRecoveryFailures" | "stalePollDetections"
  >;
  rollbackChanges: Array<{ configPath: string; previousValue: unknown }>;
  windowMs: number;
  diagnosisId?: string;
  recommendationIds?: string[];
};

let activeObservation: EvolutionObservation | null = null;

export async function startEvolutionObservation(params: {
  appliedAt: string;
  rollbackChanges: Array<{ configPath: string; previousValue: unknown }>;
  windowMs?: number;
  cfg?: OpenClawConfig;
  diagnosisId?: string;
  recommendationIds?: string[];
}): Promise<void> {
  const metrics = getOagMetrics();
  activeObservation = {
    evolutionAppliedAt: params.appliedAt,
    baselineMetrics: {
      channelRestarts: metrics.channelRestarts,
      deliveryRecoveryFailures: metrics.deliveryRecoveryFailures,
      stalePollDetections: metrics.stalePollDetections,
    },
    rollbackChanges: params.rollbackChanges,
    windowMs: params.windowMs ?? resolveOagEvolutionObservationWindowMs(params.cfg),
    diagnosisId: params.diagnosisId,
    recommendationIds: params.recommendationIds,
  };
  log.info(
    `Evolution observation started (window: ${Math.round(activeObservation.windowMs / 60_000)}min)`,
  );

  // Persist to survive restarts
  try {
    const memory = await loadOagMemory();
    memory.activeObservation = {
      evolutionAppliedAt: activeObservation.evolutionAppliedAt,
      baselineMetrics: activeObservation.baselineMetrics as Record<string, number>,
      rollbackChanges: activeObservation.rollbackChanges,
      windowMs: activeObservation.windowMs,
      diagnosisId: activeObservation.diagnosisId,
      recommendationIds: activeObservation.recommendationIds,
    };
    await saveOagMemory(memory);
  } catch {
    // Best effort
  }
}

export function getActiveObservation(): EvolutionObservation | null {
  return activeObservation;
}

export async function clearObservation(): Promise<void> {
  activeObservation = null;
  try {
    const memory = await loadOagMemory();
    memory.activeObservation = null;
    await saveOagMemory(memory);
  } catch {
    // Best effort
  }
}

export async function restoreObservationFromMemory(): Promise<boolean> {
  try {
    const memory = await loadOagMemory();
    if (!memory.activeObservation) {
      return false;
    }
    activeObservation = {
      evolutionAppliedAt: memory.activeObservation.evolutionAppliedAt,
      baselineMetrics: memory.activeObservation.baselineMetrics as Pick<
        OagMetricCounters,
        "channelRestarts" | "deliveryRecoveryFailures" | "stalePollDetections"
      >,
      rollbackChanges: memory.activeObservation.rollbackChanges,
      windowMs: memory.activeObservation.windowMs,
      diagnosisId: memory.activeObservation.diagnosisId,
      recommendationIds: memory.activeObservation.recommendationIds,
    };
    log.info("Restored evolution observation from memory");
    return true;
  } catch {
    return false;
  }
}

function detectRegression(
  observation: EvolutionObservation,
  cfg?: OpenClawConfig,
): {
  regressed: boolean;
  reason?: string;
} {
  const current = getOagMetrics();
  const baseline = observation.baselineMetrics;

  const restartDelta = current.channelRestarts - baseline.channelRestarts;
  const failureDelta = current.deliveryRecoveryFailures - baseline.deliveryRecoveryFailures;

  const restartThreshold = resolveOagEvolutionRestartRegressionThreshold(cfg);
  const failureThreshold = resolveOagEvolutionFailureRegressionThreshold(cfg);

  if (restartDelta >= restartThreshold) {
    return {
      regressed: true,
      reason: `channel restarts spiked by ${restartDelta} since evolution`,
    };
  }
  if (failureDelta >= failureThreshold) {
    return {
      regressed: true,
      reason: `delivery recovery failures spiked by ${failureDelta} since evolution`,
    };
  }

  return { regressed: false };
}

async function updateLinkedRecommendations(
  observation: EvolutionObservation,
  outcome: "effective" | "reverted",
): Promise<void> {
  if (!observation.diagnosisId || !observation.recommendationIds?.length) {
    return;
  }
  for (const recId of observation.recommendationIds) {
    try {
      await updateRecommendationOutcome(observation.diagnosisId, recId, outcome);
    } catch {
      // Best effort — don't block evolution flow for tracking failures
    }
  }
}

export async function checkEvolutionHealth(cfg?: OpenClawConfig): Promise<{
  checked: boolean;
  action: "none" | "reverted" | "confirmed";
  reason?: string;
}> {
  if (!activeObservation) {
    return { checked: false, action: "none" };
  }

  const elapsed = Date.now() - Date.parse(activeObservation.evolutionAppliedAt);

  const regression = detectRegression(activeObservation, cfg);

  if (regression.regressed) {
    log.warn(`Evolution regression detected: ${regression.reason} — rolling back`);
    const rollbackChanges = activeObservation.rollbackChanges.map((rc) => ({
      configPath: rc.configPath,
      value: rc.previousValue,
    }));
    await applyOagConfigChanges(rollbackChanges);

    // Mark evolution as reverted in memory
    try {
      const memory = await loadOagMemory();
      const lastEvolution = memory.evolutions[memory.evolutions.length - 1];
      if (lastEvolution && lastEvolution.outcome === "pending") {
        lastEvolution.outcome = "reverted";
        lastEvolution.outcomeAt = new Date().toISOString();
        await saveOagMemory(memory);
      }
    } catch {
      // Best effort
    }

    // Link recommendation outcomes to "reverted"
    await updateLinkedRecommendations(activeObservation, "reverted");

    await appendAuditEntry({
      timestamp: new Date().toISOString(),
      action: "evolution_reverted",
      detail: `Regression detected: ${regression.reason}`,
      changes: activeObservation.rollbackChanges.map((rc) => ({
        configPath: rc.configPath,
        from: undefined,
        to: rc.previousValue,
      })),
    });

    activeObservation = null;
    try {
      const mem = await loadOagMemory();
      mem.activeObservation = null;
      await saveOagMemory(mem);
    } catch {
      // Best effort
    }
    return { checked: true, action: "reverted", reason: regression.reason };
  }

  if (elapsed >= activeObservation.windowMs) {
    log.info("Evolution observation window passed — confirming as effective");

    try {
      const memory = await loadOagMemory();
      const lastEvolution = memory.evolutions[memory.evolutions.length - 1];
      if (lastEvolution && lastEvolution.outcome === "pending") {
        lastEvolution.outcome = "effective";
        lastEvolution.outcomeAt = new Date().toISOString();
        await saveOagMemory(memory);
      }
    } catch {
      // Best effort
    }

    // Link recommendation outcomes to "effective"
    await updateLinkedRecommendations(activeObservation, "effective");

    await appendAuditEntry({
      timestamp: new Date().toISOString(),
      action: "evolution_confirmed",
      detail: `Evolution confirmed effective after ${Math.round(elapsed / 60_000)}min observation`,
    });

    activeObservation = null;
    try {
      const mem = await loadOagMemory();
      mem.activeObservation = null;
      await saveOagMemory(mem);
    } catch {
      // Best effort
    }
    return { checked: true, action: "confirmed" };
  }

  return { checked: true, action: "none" };
}
