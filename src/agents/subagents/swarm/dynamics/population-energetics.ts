const ENERGETIC_REGIMES = [
  "gas",
  "liquid",
  "critical",
  "crystal",
  "glass",
  "jammed",
  "unknown",
] as const;

type EnergeticRegime = (typeof ENERGETIC_REGIMES)[number];
type EnergyLevel = "low" | "medium" | "high" | "unknown";
export type DynamicsMetric = number | null;

export type AgentEnergeticState = {
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

export type AgentEnergeticObservation = AgentEnergeticState & {
  replicaId: string;
};

type AgentEnergeticAssessment = {
  replicaId: string;
  energyLevel: EnergyLevel;
  regime: EnergeticRegime;
  score: number;
  reason: string;
};

type EnergeticAction =
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

type PopulationEnergeticsDecision = {
  authority: "search-only";
  assessments: readonly AgentEnergeticAssessment[];
  meanEnergy: number | null;
  meanTemperature: number | null;
  meanCorrelation: number | null;
  effectivePopulationSize: number | null;
  actions: readonly EnergeticAction[];
};

export type EnergeticLaunchPlan = {
  authority: "search-only";
  replicaId: string;
  regime: EnergeticRegime;
  energyLevel: EnergyLevel;
  actionKinds: readonly EnergeticAction["kind"][];
  effectivePopulationSize: number | null;
  thinking?: "low" | "medium" | "high";
  fastMode?: boolean | "auto";
  directive: string;
  suppressSpawn: boolean;
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

function classifyEnergyLevel(energy: DynamicsMetric): EnergyLevel {
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
function assessAgentEnergetics(observation: AgentEnergeticObservation): AgentEnergeticAssessment {
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

  if (temperature !== null && correlation !== null && temperature >= 0.7 && correlation <= 0.45) {
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
function assessPopulationEnergetics(
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
      reason: "raise exploratory temperature without adding more compute to a trapped basin",
    });
  }

  const crystal = idsFor(assessments, "crystal");
  if (crystal.length > 0) {
    actions.push({
      kind: "freeze",
      targetReplicaIds: crystal,
      reason: "stable low-temperature candidates should stop mutating and enter verification",
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

function actionTargets(action: EnergeticAction, replicaId: string): boolean {
  return "targetReplicaIds" in action && action.targetReplicaIds.includes(replicaId);
}

function computeControls(
  energyLevel: EnergyLevel,
): Pick<EnergeticLaunchPlan, "thinking" | "fastMode"> {
  if (energyLevel === "low") {
    return { thinking: "low", fastMode: true };
  }
  if (energyLevel === "medium") {
    return { thinking: "medium", fastMode: "auto" };
  }
  if (energyLevel === "high") {
    return { thinking: "high", fastMode: false };
  }
  return {};
}

function directiveFor(params: {
  regime: EnergeticRegime;
  actionKinds: readonly EnergeticAction["kind"][];
  temperature: DynamicsMetric;
}): string {
  const { regime, actionKinds, temperature } = params;
  if (actionKinds.includes("freeze")) {
    return "Treat this lane as crystallized: do not mutate the candidate. Independently verify the exact supplied candidate and report concrete evidence or deviations.";
  }
  if (actionKinds.includes("measure") || actionKinds.includes("deepen")) {
    return "Spend the extra reasoning budget on a discriminating measurement that resolves the active disagreement. Do not widen the search until that evidence is obtained.";
  }
  if (actionKinds.includes("reheat")) {
    return "Reheat this lane by breaking correlation with the current basin: change assumptions, decomposition, tools, or search path and seek genuinely novel evidence instead of continuing the same trajectory.";
  }
  if (regime === "gas" || (temperature !== null && temperature >= 0.7)) {
    return "Stay exploratory: generate a distinct hypothesis or path, preserve diversity, and avoid premature convergence on the population consensus.";
  }
  if (regime === "liquid") {
    return "Remain mobile while recombining useful partial structure from the population; prefer progress that preserves alternative paths.";
  }
  if (temperature !== null && temperature <= 0.2) {
    return "Keep exploratory temperature low: preserve established facts and avoid gratuitous mutation while checking the current path carefully.";
  }
  return "Follow the task normally; no additional energetic transition is justified by the measured state.";
}

/**
 * Convert a measured local/population state into concrete launch behavior.
 *
 * This is where the physics model affects the next agent: energy controls the
 * native reasoning budget, while temperature/regime controls the behavioral
 * directive. A jammed lane is not launched at all.
 */
export function planEnergeticLaunch(params: {
  replicaId: string;
  state: AgentEnergeticState;
  peers?: readonly AgentEnergeticObservation[];
}): EnergeticLaunchPlan {
  const current: AgentEnergeticObservation = {
    replicaId: params.replicaId,
    ...params.state,
  };
  const decision = assessPopulationEnergetics([current, ...(params.peers ?? [])]);
  const assessment = decision.assessments.find((item) => item.replicaId === params.replicaId);
  if (!assessment) {
    throw new Error("population energetics lost the target replica");
  }
  const targeted = decision.actions.filter((action) => actionTargets(action, params.replicaId));
  const actionKinds = targeted.map((action) => action.kind);
  const suppressSpawn = actionKinds.includes("drain");
  const controls = computeControls(assessment.energyLevel);

  if (actionKinds.includes("deepen") || actionKinds.includes("freeze")) {
    controls.thinking = "high";
    controls.fastMode = false;
  }

  return {
    authority: "search-only",
    replicaId: params.replicaId,
    regime: assessment.regime,
    energyLevel: assessment.energyLevel,
    actionKinds,
    effectivePopulationSize: decision.effectivePopulationSize,
    ...controls,
    directive: directiveFor({
      regime: assessment.regime,
      actionKinds,
      temperature: params.state.temperature,
    }),
    suppressSpawn,
  };
}
