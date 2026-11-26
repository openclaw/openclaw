import type {
  DictationRefinementPolicy,
  DictationRefinementResult,
  DictationRefinementSource,
} from "./dictation-refinement.ts";

/** Preserve recognized text until an accepted owner can decide correction intent. */
export function prepareDictationRefinement(
  source: DictationRefinementSource,
  policy: DictationRefinementPolicy,
): DictationRefinementResult {
  const reason =
    policy.mode !== "explicit" ? "off" : policy.literal ? "literal" : "corrections-unavailable";
  return {
    status: reason === "corrections-unavailable" ? "unavailable" : "unchanged",
    original: source.text,
    candidate: source.text,
    plan: null,
    reasons: [reason],
  };
}
