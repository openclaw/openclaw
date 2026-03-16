import { createSubsystemLogger } from "../logging/subsystem.js";
import { applyOagConfigChanges } from "./oag-config-writer.js";
import { loadOagMemory, saveOagMemory } from "./oag-memory.js";
import { getOagMetrics, type OagMetricCounters } from "./oag-metrics.js";

const log = createSubsystemLogger("oag/evolution-guard");

const DEFAULT_OBSERVATION_WINDOW_MS = 60 * 60_000; // 1 hour

export type EvolutionObservation = {
  evolutionAppliedAt: string;
  baselineMetrics: Pick<
    OagMetricCounters,
    "channelRestarts" | "deliveryRecoveryFailures" | "stalePollDetections"
  >;
  rollbackChanges: Array<{ configPath: string; previousValue: unknown }>;
  windowMs: number;
};

let activeObservation: EvolutionObservation | null = null;

export function startEvolutionObservation(params: {
  appliedAt: string;
  rollbackChanges: Array<{ configPath: string; previousValue: unknown }>;
  windowMs?: number;
}): void {
  const metrics = getOagMetrics();
  activeObservation = {
    evolutionAppliedAt: params.appliedAt,
    baselineMetrics: {
      channelRestarts: metrics.channelRestarts,
      deliveryRecoveryFailures: metrics.deliveryRecoveryFailures,
      stalePollDetections: metrics.stalePollDetections,
    },
    rollbackChanges: params.rollbackChanges,
    windowMs: params.windowMs ?? DEFAULT_OBSERVATION_WINDOW_MS,
  };
  log.info(
    `Evolution observation started (window: ${Math.round(activeObservation.windowMs / 60_000)}min)`,
  );
}

export function getActiveObservation(): EvolutionObservation | null {
  return activeObservation;
}

export function clearObservation(): void {
  activeObservation = null;
}

function detectRegression(observation: EvolutionObservation): {
  regressed: boolean;
  reason?: string;
} {
  const current = getOagMetrics();
  const baseline = observation.baselineMetrics;

  const restartDelta = current.channelRestarts - baseline.channelRestarts;
  const failureDelta = current.deliveryRecoveryFailures - baseline.deliveryRecoveryFailures;

  if (restartDelta >= 5) {
    return {
      regressed: true,
      reason: `channel restarts spiked by ${restartDelta} since evolution`,
    };
  }
  if (failureDelta >= 3) {
    return {
      regressed: true,
      reason: `delivery recovery failures spiked by ${failureDelta} since evolution`,
    };
  }

  return { regressed: false };
}

export async function checkEvolutionHealth(): Promise<{
  checked: boolean;
  action: "none" | "reverted" | "confirmed";
  reason?: string;
}> {
  if (!activeObservation) {
    return { checked: false, action: "none" };
  }

  const elapsed = Date.now() - Date.parse(activeObservation.evolutionAppliedAt);

  const regression = detectRegression(activeObservation);

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

    activeObservation = null;
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

    activeObservation = null;
    return { checked: true, action: "confirmed" };
  }

  return { checked: true, action: "none" };
}
