import type { SetupInferenceCandidate } from "./setup-inference-core.js";

function candidateRank(candidate: SetupInferenceCandidate): number | undefined {
  if (candidate.modelTarget === "utility" || candidate.credentials === false) {
    return undefined;
  }
  if (candidate.kind === "existing-model") {
    return 0;
  }
  if (candidate.kind.startsWith("saved-auth:")) {
    return 1;
  }
  if (candidate.kind === "codex-cli") {
    return candidate.credentials === true ? 2 : undefined;
  }
  if (candidate.kind === "claude-cli") {
    return 3;
  }
  if (candidate.kind === "openai-api-key") {
    return 4;
  }
  if (candidate.kind === "anthropic-api-key") {
    return 5;
  }
  if (candidate.kind.startsWith("provider-auto:")) {
    switch (candidate.modelRef.split("/", 1)[0]) {
      case "ollama":
        return 6;
      case "lmstudio":
        return 7;
      case "llama-cpp":
        return 8;
    }
  }
  return undefined;
}

/** Shared first-run policy; manual discovery retains candidates outside this ladder. */
export function rankSetupInferenceCandidates(
  candidates: readonly SetupInferenceCandidate[],
): SetupInferenceCandidate[] {
  return candidates
    .map((candidate) => ({ candidate, rank: candidateRank(candidate) }))
    .filter(
      (entry): entry is { candidate: SetupInferenceCandidate; rank: number } =>
        entry.rank !== undefined,
    )
    .toSorted(
      (a, b) =>
        a.rank - b.rank ||
        a.candidate.kind.localeCompare(b.candidate.kind) ||
        a.candidate.modelRef.localeCompare(b.candidate.modelRef),
    )
    .map(({ candidate }) => candidate);
}
