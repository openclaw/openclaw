import type { BoundedLaunchBoundary, HandoffManifest } from "./bounded-launch-types.js";

export type HandoffPayload = {
  candidateDigest?: string;
  artifactRefs?: readonly string[];
  evidenceRefs?: readonly string[];
  summary?: string;
};

export function buildHandoffManifest(params: {
  sourceRunId: string;
  targetLaunchId: string;
  boundary: BoundedLaunchBoundary;
  payload: HandoffPayload;
}): HandoffManifest {
  const artifactRefs = params.payload.artifactRefs ?? [];
  const evidenceRefs = params.payload.evidenceRefs ?? [];

  switch (params.boundary) {
    case "isolated":
      return {
        version: 1,
        sourceRunId: params.sourceRunId,
        targetLaunchId: params.targetLaunchId,
        boundary: params.boundary,
        artifactRefs: [],
        evidenceRefs: [],
      };
    case "artifact-only":
      return {
        version: 1,
        sourceRunId: params.sourceRunId,
        targetLaunchId: params.targetLaunchId,
        boundary: params.boundary,
        candidateDigest: params.payload.candidateDigest,
        artifactRefs,
        evidenceRefs: [],
      };
    case "evidence-only":
      return {
        version: 1,
        sourceRunId: params.sourceRunId,
        targetLaunchId: params.targetLaunchId,
        boundary: params.boundary,
        candidateDigest: params.payload.candidateDigest,
        artifactRefs: [],
        evidenceRefs,
      };
    case "summary-only":
      return {
        version: 1,
        sourceRunId: params.sourceRunId,
        targetLaunchId: params.targetLaunchId,
        boundary: params.boundary,
        artifactRefs: [],
        evidenceRefs: [],
        summary: params.payload.summary,
      };
    default: {
      const exhaustiveBoundary: never = params.boundary;
      throw new Error(`Unsupported bounded launch handoff boundary: ${String(exhaustiveBoundary)}`);
    }
  }
}
