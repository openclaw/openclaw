import {
  COGNITIVE_PHASES,
  type CognitivePhase,
  type DynamicsMetric,
  type LocalDynamicsObservation,
  type LocalPhaseAssessment,
  type PhaseMixture,
} from "./population-types.js";

const PHASES = new Set<CognitivePhase>(COGNITIVE_PHASES);

function validateUnitMetric(value: DynamicsMetric, name: string): void {
  if (value === null) {
    return;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be unknown or finite and in [0, 1]`);
  }
}

function validateDynamicsObservation(observation: LocalDynamicsObservation): void {
  if (typeof observation.replicaId !== "string" || !observation.replicaId.trim()) {
    throw new Error("replicaId must be non-empty");
  }
  for (const key of [
    "candidateEntropy",
    "coherence",
    "mobility",
    "evidenceCompleteness",
    "verifierDisagreement",
    "resourcePressure",
    "contextPressure",
    "debtPressure",
    "progressRate",
  ] as const) {
    validateUnitMetric(observation[key], key);
  }
  if (
    observation.branchingRatio !== null &&
    (!Number.isFinite(observation.branchingRatio) || observation.branchingRatio < 0)
  ) {
    throw new Error("branchingRatio must be unknown or finite and non-negative");
  }
}

function maximumKnown(values: readonly DynamicsMetric[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : Math.max(...known);
}

export function assessLocalPhase(observation: LocalDynamicsObservation): LocalPhaseAssessment {
  validateDynamicsObservation(observation);
  const {
    candidateEntropy,
    coherence,
    mobility,
    evidenceCompleteness,
    verifierDisagreement,
    resourcePressure,
    contextPressure,
    debtPressure,
    progressRate,
  } = observation;
  const pressure = maximumKnown([resourcePressure, contextPressure, debtPressure]);
  let phase: CognitivePhase = "unknown";
  let confidence = 0;
  let reason = "insufficient measured telemetry";

  if (pressure !== null && pressure >= 0.85) {
    phase = "jammed";
    confidence = pressure;
    reason = "resource/context/debt pressure dominates";
  } else if (verifierDisagreement !== null && verifierDisagreement >= 0.55) {
    phase = "critical";
    confidence = verifierDisagreement;
    reason = "verifier disagreement requires measurement before perturbation";
  } else if (
    mobility !== null &&
    evidenceCompleteness !== null &&
    progressRate !== null &&
    mobility <= 0.2 &&
    evidenceCompleteness < 0.75 &&
    progressRate <= 0.2
  ) {
    phase = "glass";
    confidence = (1 - mobility + (1 - progressRate)) / 2;
    reason = "low mobility and low progress without sufficient evidence";
  } else if (
    candidateEntropy !== null &&
    candidateEntropy >= 0.45 &&
    candidateEntropy <= 0.65
  ) {
    phase = "critical";
    confidence = 1 - Math.abs(candidateEntropy - 0.55);
    reason = "candidate entropy is in the experimental transition band";
  } else if (
    candidateEntropy !== null &&
    coherence !== null &&
    evidenceCompleteness !== null &&
    verifierDisagreement !== null &&
    candidateEntropy <= 0.2 &&
    coherence >= 0.8 &&
    evidenceCompleteness >= 0.8 &&
    verifierDisagreement <= 0.15
  ) {
    phase = "crystal";
    confidence = (coherence + evidenceCompleteness + (1 - candidateEntropy)) / 3;
    reason = "low candidate entropy with high coherence and evidence completeness";
  } else if (
    candidateEntropy !== null &&
    coherence !== null &&
    candidateEntropy >= 0.7 &&
    coherence <= 0.45
  ) {
    phase = "gas";
    confidence = (candidateEntropy + (1 - coherence)) / 2;
    reason = "high candidate entropy with low coherence";
  } else if (
    mobility !== null &&
    coherence !== null &&
    mobility >= 0.35 &&
    coherence >= 0.45
  ) {
    phase = "liquid";
    confidence = (mobility + coherence) / 2;
    reason = "productive mobility with moderate coherence";
  }

  // This score is a heuristic, not calibrated statistical confidence.
  return { replicaId: observation.replicaId, phase, confidence, reason };
}

export function phaseMixture(assessments: readonly LocalPhaseAssessment[]): PhaseMixture {
  const counts: PhaseMixture = {
    gas: 0,
    liquid: 0,
    critical: 0,
    crystal: 0,
    glass: 0,
    jammed: 0,
    unknown: 0,
  };
  if (assessments.length === 0) {
    counts.unknown = 1;
    return counts;
  }
  const seen = new Set<string>();
  for (const assessment of assessments) {
    if (!PHASES.has(assessment.phase) || seen.has(assessment.replicaId)) {
      throw new Error("phase mixture requires one valid assessment per replica");
    }
    seen.add(assessment.replicaId);
    counts[assessment.phase] += 1;
  }
  for (const phase of COGNITIVE_PHASES) {
    counts[phase] /= assessments.length;
  }
  return counts;
}
