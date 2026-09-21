import type { ResolvedDynamicsProfile } from "./dynamics-types.js";

type CognitiveReplica = {
  replicaId: string;
  campaignId: string;
  groupId: string;
  runId: string;
  requesterSessionKey: string;
  parentReplicaId?: string;
  profile: ResolvedDynamicsProfile;
  authority: "search-only";
};

export const COGNITIVE_PHASES = [
  "gas",
  "liquid",
  "critical",
  "crystal",
  "glass",
  "jammed",
  "unknown",
] as const;

export type CognitivePhase = (typeof COGNITIVE_PHASES)[number];

export type DynamicsMetric = number | null;

export type LocalDynamicsObservation = {
  replicaId: string;
  candidateEntropy: DynamicsMetric;
  coherence: DynamicsMetric;
  mobility: DynamicsMetric;
  evidenceCompleteness: DynamicsMetric;
  verifierDisagreement: DynamicsMetric;
  resourcePressure: DynamicsMetric;
  contextPressure: DynamicsMetric;
  debtPressure: DynamicsMetric;
  branchingRatio: DynamicsMetric;
  progressRate: DynamicsMetric;
};

export type LocalPhaseAssessment = {
  replicaId: string;
  phase: CognitivePhase;
  confidence: number;
  reason: string;
};

export type PhaseMixture = Record<CognitivePhase, number>;

export type PopulationSnapshot = {
  campaignId: string;
  groupId: string;
  replicas: readonly CognitiveReplica[];
  observations: readonly LocalDynamicsObservation[];
  phaseMixture: PhaseMixture;
  meanCorrelation: number | null;
  candidateEntropy: number | null;
  evidenceCompleteness: number | null;
  resourcePressure: number | null;
  contextPressure: number | null;
  debtPressure: number | null;
};

export type DynamicsAction =
  | { kind: "spawn"; profile: string; count: number; reason: string }
  | { kind: "measure"; targetReplicaIds: readonly string[]; reason: string }
  | { kind: "freeze"; targetReplicaIds: readonly string[]; reason: string }
  | { kind: "perturb"; profile: string; count: number; reason: string }
  | { kind: "drain"; reason: string }
  | { kind: "hold"; reason: string };

export type PopulationDecision = {
  authority: "search-only";
  actions: readonly DynamicsAction[];
  rationale: readonly string[];
};
