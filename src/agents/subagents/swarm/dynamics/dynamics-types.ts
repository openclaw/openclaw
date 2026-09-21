export type InformationBoundary =
  | "isolated"
  | "artifact-only"
  | "evidence-only"
  | "summary-only";

export type DynamicsRequirement = "optional" | "required";

export type DynamicsSpawnRequirements = {
  sandbox: "inherit" | "require";
  candidateDigest: DynamicsRequirement;
  artifactRefs: DynamicsRequirement;
};

export type DynamicsContract = {
  version: 1;
  boundary: InformationBoundary;
  requirements: DynamicsSpawnRequirements;
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
