import { assessLocalPhase, phaseMixture } from "./phase-assessment.js";
import type {
  DynamicsAction,
  LocalDynamicsObservation,
  LocalPhaseAssessment,
  PopulationDecision,
  PopulationSnapshot,
} from "./population-types.js";

function mean(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0) / known.length;
}

function maximum(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : Math.max(...known);
}

export function buildPopulationSnapshot(params: {
  campaignId: string;
  groupId: string;
  replicas: PopulationSnapshot["replicas"];
  observations: readonly LocalDynamicsObservation[];
  meanCorrelation?: number | null;
}): PopulationSnapshot {
  if (!params.campaignId.trim() || !params.groupId.trim()) {
    throw new Error("population campaign and group must be non-empty");
  }
  const correlation = params.meanCorrelation ?? null;
  if (
    correlation !== null &&
    (!Number.isFinite(correlation) || correlation < 0 || correlation > 1)
  ) {
    throw new Error("population correlation must be unknown or finite and in [0, 1]");
  }
  const replicaIds = new Set<string>();
  for (const replica of params.replicas) {
    if (
      !replica.replicaId.trim() ||
      replicaIds.has(replica.replicaId) ||
      replica.campaignId !== params.campaignId ||
      replica.groupId !== params.groupId
    ) {
      throw new Error(
        "population replicas must have unique identities in the same campaign and group",
      );
    }
    replicaIds.add(replica.replicaId);
  }
  const observations = params.observations.map((item) => ({ ...item }));
  const assessments: LocalPhaseAssessment[] = observations.map(assessLocalPhase);
  const observedIds = new Set<string>();
  for (const assessment of assessments) {
    if (
      observedIds.has(assessment.replicaId) ||
      (replicaIds.size > 0 && !replicaIds.has(assessment.replicaId))
    ) {
      throw new Error("population observations must identify unique declared replicas");
    }
    observedIds.add(assessment.replicaId);
  }
  for (const replicaId of replicaIds) {
    if (!observedIds.has(replicaId)) {
      assessments.push({ replicaId, phase: "unknown", confidence: 0, reason: "no observation" });
    }
  }
  return {
    campaignId: params.campaignId,
    groupId: params.groupId,
    replicas: params.replicas.map((replica) => ({ ...replica, profile: { ...replica.profile } })),
    observations,
    phaseMixture: phaseMixture(assessments),
    meanCorrelation: correlation,
    candidateEntropy: mean(observations.map((item) => item.candidateEntropy)),
    evidenceCompleteness: mean(observations.map((item) => item.evidenceCompleteness)),
    // Conservative pressure bounds: averaging must not hide one saturated lane.
    resourcePressure: maximum(observations.map((item) => item.resourcePressure)),
    contextPressure: maximum(observations.map((item) => item.contextPressure)),
    debtPressure: maximum(observations.map((item) => item.debtPressure)),
  };
}

export function assessPopulation(input: PopulationSnapshot): PopulationDecision {
  // Recompute projections rather than accepting a caller's claimed phase or pressure.
  const snapshot = buildPopulationSnapshot(input);
  const actions: DynamicsAction[] = [];
  const rationale: string[] = [];
  const mix = snapshot.phaseMixture;
  const systemPressure = Math.max(
    snapshot.resourcePressure ?? 0,
    snapshot.contextPressure ?? 0,
    snapshot.debtPressure ?? 0,
  );
  if (systemPressure >= 0.8 || mix.jammed >= 0.25) {
    actions.push({
      kind: "drain",
      reason: "resource/context/debt pressure is too high for further expansion",
    });
    rationale.push("jammed pressure takes precedence over exploratory expansion");
    return { authority: "search-only", actions, rationale };
  }
  if (mix.critical >= 0.2) {
    const targets = snapshot.observations
      .filter((item) => assessLocalPhase(item).phase === "critical")
      .map((item) => item.replicaId);
    actions.push({
      kind: "measure",
      targetReplicaIds: targets,
      reason: "critical replicas require discriminating measurements before widening search",
    });
    rationale.push("critical behavior shifts budget from blind expansion to measurement");
  }
  if (mix.glass >= 0.15) {
    actions.push({
      kind: "perturb",
      profile: "glass-breaker",
      count: 1,
      reason: "bounded fresh-context perturbation for stalled low-mobility search",
    });
    rationale.push("glassy lanes get one bounded decorrelated perturbation");
  }
  const frozenTargets = snapshot.observations
    .filter((item) => assessLocalPhase(item).phase === "crystal")
    .map((item) => item.replicaId);
  if (frozenTargets.length > 0) {
    // Freeze eligible local lanes; unrelated hot exploration cannot dilute their evidence.
    actions.push({
      kind: "freeze",
      targetReplicaIds: frozenTargets,
      reason: "low-entropy candidates with substantial evidence should be frozen for verification",
    });
    rationale.push("crystal-like candidates stop mutating; authority remains unchanged");
  }
  if (mix.gas >= 0.4 && mix.critical === 0 && systemPressure < 0.6) {
    actions.push({
      kind: "spawn",
      profile: "builder",
      count: 1,
      reason: "broad exploration has enough diversity to justify one coordinating builder",
    });
    rationale.push("gas-heavy populations get a bounded coordinating lane, not unlimited fan-out");
  }
  if (actions.length === 0) {
    actions.push({ kind: "hold", reason: "current population does not justify a control change" });
    rationale.push("absence of a distinctive signal preserves current search posture");
  }
  return { authority: "search-only", actions, rationale };
}
