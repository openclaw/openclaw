export const ENERGETIC_REGIMES = [
  "gas",
  "liquid",
  "critical",
  "crystal",
  "glass",
  "jammed",
  "unknown",
] as const;

export type EnergeticRegime = (typeof ENERGETIC_REGIMES)[number];
export type EnergyLevel = "low" | "medium" | "high" | "unknown";
export type DynamicsMetric = number | null;

export type AgentEnergeticObservation = {
  replicaId: string;
  /**
   * Normalized compute intensity committed to this replica. Energy is distinct
   * from temperature: a verifier may be high-energy and low-temperature.
   */
  energy: DynamicsMetric;
  /** Normalized exploratory freedom / stochasticity. */
  temperature: DynamicsMetric;
  mobility: DynamicsMetric;
  noveltyRate: DynamicsMetric;
  evidenceCompleteness: DynamicsMetric;
  verifierDisagreement: DynamicsMetric;
  correlation: DynamicsMetric;
  susceptibility: DynamicsMetric;
  resourcePressure: DynamicsMetric;
};

export type AgentEnergeticAssessment = {
  replicaId: string;
  energyLevel: EnergyLevel;
  regime: EnergeticRegime;
  score: number;
  reason: string;
};

export type EnergeticAction =
  | {
      kind: "measure";
      targetReplicaIds: readonly string[];
      reason: string;
    }
  | {
      kind: "deepen";
      targetReplicaIds: readonly string[];
      reason: string;
    }
  | {
      kind: "reheat";
      targetReplicaIds: readonly string[];
      reason: string;
    }
  | {
      kind: "freeze";
      targetReplicaIds: readonly string[];
      reason: string;
    }
  | {
      kind: "drain";
      targetReplicaIds: readonly string[];
      reason: string;
    }
  | {
      kind: "hold";
      reason: string;
    };

export type PopulationEnergeticsDecision = {
  authority: "search-only";
  assessments: readonly AgentEnergeticAssessment[];
  meanEnergy: number | null;
  meanTemperature: number | null;
  meanCorrelation: number | null;
  effectivePopulationSize: number | null;
  actions: readonly EnergeticAction[];
};

function validateUnitMetric(value: DynamicsMetric, name: string): void {
  if (value === null) {
    return;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be unknown or finite and in [0, 1]`);
  }
}

function validateObservation(observation: AgentEnergeticObservation): void {
  if (!observation.replicaId.trim()) {
    throw new Error("replicaId must be non-empty");
  }
  for (const key of [
    "energy",
    "temperature",
    "mobility",
    "noveltyRate",
    "evidenceCompleteness",
    "verifierDisagreement",
    "correlation",
    "susceptibility",
    "resourcePressure",
  ] as const) {
    validateUnitMetric(observation[key], key);
  }
}

function meanKnown(values: readonly DynamicsMetric[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0) / known.length;
}

function maxKnown(values: readonly DynamicsMetric[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : Math.max(...known);
}

function scoreMean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function classifyEnergyLevel(energy: DynamicsMetric): EnergyLevel {
  if (energy === null) {
    return "unknown";
  }
  validateUnitMetric(energy, "energy");
  if (energy < 0.3) {
    return "low";
  }
  if (energy < 0.7) {
    return "medium";
  }
  return "high";
}

/**
 * Infer one local dynamical regime from measured state.
 *
 * These are engineering control regimes, not claims of literal equilibrium
 * thermodynamics. Energy and temperature are intentionally orthogonal.
 */
export function assessAgentEnergetics(
  observation: AgentEnergeticObservation,
): AgentEnergeticAssessment {
  validateObservation(observation);
  const {
    energy,
    temperature,
    mobility,
    noveltyRate,
    evidenceCompleteness,
    verifierDisagreement,
    correlation,
    susceptibility,
    resourcePressure,
  } = observation;
  const energyLevel = classifyEnergyLevel(energy);

  if (resourcePressure !== null && resourcePressure >= 0.85) {
    return {
      replicaId: observation.replicaId,
      energyLevel,
      regime: "jammed",
      score: resourcePressure,
      reason: "resource pressure dominates useful search",
    };
  }

  const criticalSignal = maxKnown([verifierDisagreement, susceptibility]);
  if (criticalSignal !== null && criticalSignal >= 0.6) {
    return {
      replicaId: observation.replicaId,
      energyLevel,
      regime: "critical",
      score: criticalSignal,
      reason: "disagreement or perturbation susceptibility makes measurement valuable",
    };
  }

  if (
    temperature !== null &&
    mobility !== null &&
    evidenceCompleteness !== null &&
    verifierDisagreement !== null &&
    temperature <= 0.2 &&
    mobility <= 0.2 &&
    evidenceCompleteness >= 0.8 &&
    verifierDisagreement <= 0.15
  ) {
    return {
      replicaId: observation.replicaId,
      energyLevel,
      regime: "crystal",
      score: scoreMean([
        1 - temperature,
        1 - mobility,
        evidenceCompleteness,
        1 - verifierDisagreement,
      ]),
      reason: "low-temperature stable state has enough evidence to freeze",
    };
  }

  if (
    energy !== null &&
    mobility !== null &&
    noveltyRate !== null &&
    correlation !== null &&
    energy >= 0.55 &&
    mobility <= 0.2 &&
    noveltyRate <= 0.2 &&
    correlation >= 0.65
  ) {
    return {
      replicaId: observation.replicaId,
      energyLevel,
      regime: "glass",
      score: scoreMean([energy, 1 - mobility, 1 - noveltyRate, correlation]),
      reason: "high compute is trapped in correlated low-mobility search",
    };
  }

  if (
    temperature !== null &&
    correlation !== null &&
    temperature >= 0.7 &&
    correlation <= 0.45
  ) {
    return {
      replicaId: observation.replicaId,
      energyLevel,
      regime: "gas",
      score: scoreMean([temperature, 1 - correlation]),
      reason: "high-temperature decorrelated exploration",
    };
  }

  if (
    temperature !== null &&
    mobility !== null &&
    correlation !== null &&
    temperature >= 0.25 &&
    temperature < 0.7 &&
    mobility >= 0.35 &&
    correlation >= 0.2 &&
    correlation <= 0.75
  ) {
    return {
      replicaId: observation.replicaId,
      energyLevel,
      regime: "liquid",
      score: scoreMean([mobility, 1 - Math.abs(temperature - 0.5), 1 - correlation / 2]),
      reason: "mobile search combines exploration with partial coordination",
    };
  }

  return {
    replicaId: observation.replicaId,
    energyLevel,
    regime: "unknown",
    score: 0,
    reason: "insufficient measured telemetry for a dynamical regime",
  };
}

function idsFor(
  assessments: readonly AgentEnergeticAssessment[],
  regime: EnergeticRegime,
): string[] {
  return assessments
    .filter((assessment) => assessment.regime === regime)
    .map((assessment) => assessment.replicaId);
}

/**
 * Search-only control law over a heterogeneous population.
 *
 * The output describes where compute should move next; it does not spawn,
 * sandbox, approve, publish, merge, or deploy anything.
 */
export function assessPopulationEnergetics(
  observations: readonly AgentEnergeticObservation[],
): PopulationEnergeticsDecision {
  const seen = new Set<string>();
  const observationsCopy = observations.map((observation) => {
    validateObservation(observation);
    if (seen.has(observation.replicaId)) {
      throw new Error("population energetics requires unique replica ids");
    }
    seen.add(observation.replicaId);
    return { ...observation };
  });
  const assessments = observationsCopy.map(assessAgentEnergetics);
  const actions: EnergeticAction[] = [];

  const jammed = idsFor(assessments, "jammed");
  if (jammed.length > 0) {
    actions.push({
      kind: "drain",
      targetReplicaIds: jammed,
      reason: "remove pressure before spending more compute on saturated lanes",
    });
  }

  const critical = idsFor(assessments, "critical");
  if (critical.length > 0) {
    actions.push({
      kind: "measure",
      targetReplicaIds: critical,
      reason: "critical disagreement should buy discriminating evidence before blind fan-out",
    });
    actions.push({
      kind: "deepen",
      targetReplicaIds: critical,
      reason: "raise reasoning energy on informative disagreement without raising temperature",
    });
  }

  const glass = idsFor(assessments, "glass");
  if (glass.length > 0) {
    actions.push({
      kind: "reheat",
      targetReplicaIds: glass,
      reason: "raise exploratory temperature without simply adding more compute to a trapped basin",
    });
  }

  const crystal = idsFor(assessments, "crystal");
  if (crystal.length > 0) {
    actions.push({
      kind: "freeze",
      targetReplicaIds: crystal,
      reason: "stable low-temperature candidates should stop mutating and enter exact verification",
    });
  }

  const meanEnergy = meanKnown(observationsCopy.map((item) => item.energy));
  const meanTemperature = meanKnown(observationsCopy.map((item) => item.temperature));
  const meanCorrelation = meanKnown(observationsCopy.map((item) => item.correlation));
  const effectivePopulationSize =
    meanCorrelation === null || observationsCopy.length === 0
      ? null
      : observationsCopy.length /
        (1 + (observationsCopy.length - 1) * Math.max(0, meanCorrelation));

  if (
    meanCorrelation !== null &&
    meanCorrelation >= 0.8 &&
    observationsCopy.length > 1 &&
    glass.length === 0
  ) {
    const frozen = new Set([...crystal, ...jammed]);
    const targets = assessments
      .filter((assessment) => !frozen.has(assessment.replicaId))
      .map((assessment) => assessment.replicaId);
    if (targets.length > 0) {
      actions.push({
        kind: "reheat",
        targetReplicaIds: targets,
        reason: "population correlation has collapsed effective independent search capacity",
      });
    }
  }

  if (actions.length === 0) {
    actions.push({
      kind: "hold",
      reason: "measured state does not justify an energetic transition",
    });
  }

  return {
    authority: "search-only",
    assessments,
    meanEnergy,
    meanTemperature,
    meanCorrelation,
    effectivePopulationSize,
    actions,
  };
}
