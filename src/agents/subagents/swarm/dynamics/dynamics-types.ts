export type BoundedLaunchBoundary = "isolated" | "artifact-only" | "evidence-only" | "summary-only";

export type BoundedLaunchRequirement = "optional" | "required";

export type BoundedLaunchRequirements = {
  sandbox: "inherit" | "require";
  candidateDigest: BoundedLaunchRequirement;
  artifactRefs: BoundedLaunchRequirement;
};

export type HandoffManifest = {
  version: 1;
  sourceReplicaId: string;
  targetReplicaId: string;
  boundary: BoundedLaunchBoundary;
  candidateDigest?: string;
  artifactRefs: readonly string[];
  evidenceRefs: readonly string[];
  summary?: string;
};
