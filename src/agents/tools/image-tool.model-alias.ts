// Execution-alias shadowing rules for image tool model candidates, split from
// image-tool.ts so the tool module stays within its line-cap ratchet.
import { normalizeMediaProviderId } from "../../../packages/media-understanding-common/src/provider-id.js";
import { isMinimaxVlmProvider } from "../minimax-vlm.js";

function modelRefProvider(candidate: string | null | undefined): string | undefined {
  const trimmed = candidate?.trim();
  if (!trimmed?.includes("/")) {
    return undefined;
  }
  return trimmed.slice(0, trimmed.indexOf("/")).trim();
}

export function isExecutionAliasCandidateForProvider(
  candidate: string | null | undefined,
  provider: string,
): boolean {
  const candidateProvider = modelRefProvider(candidate);
  return Boolean(
    candidateProvider &&
    candidateProvider !== normalizeMediaProviderId(candidateProvider) &&
    normalizeMediaProviderId(candidateProvider) === normalizeMediaProviderId(provider),
  );
}

export function isCanonicalCandidateShadowedByExecutionAlias(
  candidate: string | null | undefined,
  candidates: readonly (string | null | undefined)[],
): boolean {
  const candidateProvider = modelRefProvider(candidate);
  if (!candidateProvider || candidateProvider !== normalizeMediaProviderId(candidateProvider)) {
    return false;
  }
  if (!isMinimaxVlmProvider(candidateProvider)) {
    return false;
  }
  return candidates.some((shadowCandidate) =>
    isExecutionAliasCandidateForProvider(shadowCandidate, candidateProvider),
  );
}
