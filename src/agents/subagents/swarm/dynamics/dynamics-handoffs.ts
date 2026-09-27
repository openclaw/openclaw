import type { HandoffManifest, InformationBoundary } from "./dynamics-types.js";

export type HandoffPayload = {
  candidateDigest?: string;
  artifactRefs?: readonly string[];
  evidenceRefs?: readonly string[];
  summary?: string;
};

export function buildHandoffManifest(params: {
  sourceReplicaId: string;
  targetReplicaId: string;
  boundary: InformationBoundary;
  payload: HandoffPayload;
}): HandoffManifest {
  const artifactRefs = params.payload.artifactRefs ?? [];
  const evidenceRefs = params.payload.evidenceRefs ?? [];

  switch (params.boundary) {
    case "isolated":
      return {
        version: 1,
        sourceReplicaId: params.sourceReplicaId,
        targetReplicaId: params.targetReplicaId,
        boundary: params.boundary,
        artifactRefs: [],
        evidenceRefs: [],
      };
    case "artifact-only":
      return {
        version: 1,
        sourceReplicaId: params.sourceReplicaId,
        targetReplicaId: params.targetReplicaId,
        boundary: params.boundary,
        candidateDigest: params.payload.candidateDigest,
        artifactRefs,
        evidenceRefs: [],
      };
    case "evidence-only":
      return {
        version: 1,
        sourceReplicaId: params.sourceReplicaId,
        targetReplicaId: params.targetReplicaId,
        boundary: params.boundary,
        candidateDigest: params.payload.candidateDigest,
        artifactRefs: [],
        evidenceRefs,
      };
    case "summary-only":
      return {
        version: 1,
        sourceReplicaId: params.sourceReplicaId,
        targetReplicaId: params.targetReplicaId,
        boundary: params.boundary,
        artifactRefs: [],
        evidenceRefs: [],
        summary: params.payload.summary,
      };
    default: {
      const exhaustiveBoundary: never = params.boundary;
      throw new Error(`Unsupported dynamics handoff boundary: ${String(exhaustiveBoundary)}`);
    }
  }
}
