type DynamicsRole =
  | "explorer"
  | "builder"
  | "integrator"
  | "critic"
  | "security"
  | "performance"
  | "reproducer"
  | "verifier"
  | "glass-breaker";

export type InformationBoundary =
  | "isolated"
  | "artifact-only"
  | "evidence-only"
  | "summary-only"
  | "fork";

export type DynamicsRequirement = "optional" | "required";

export type DynamicsSpawnRequirements = {
  sandbox: "inherit" | "require";
  candidateDigest: DynamicsRequirement;
  artifactRefs: DynamicsRequirement;
};

export type DynamicsProfile = {
  version: 1;
  id: string;
  role: DynamicsRole;
  effectiveTemperature: number;
  mutationBudget: number;
  verificationWeight: number;
  contextBoundary: InformationBoundary;
  requirements: DynamicsSpawnRequirements;
};

export type ResolvedDynamicsProfile = DynamicsProfile & {
  digestInput: string;
};

export type HandoffManifest = {
  version: 1;
  sourceReplicaId: string;
  targetReplicaId: string;
  boundary: InformationBoundary;
  candidateDigest?: string;
  artifactRefs: readonly string[];
  evidenceRefs: readonly string[];
  summary?: string;
};
