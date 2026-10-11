import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";

export type BoundedLaunchCandidateBinding = {
  version: 1;
  candidateDigest: string;
  sourceDigest: string;
  recipeDigest: string;
  policyDigest: string;
};

function requireText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function stableDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

/**
 * Bind the exact candidate bytes and the source/recipe/policy context that produced them.
 * This is an identity binding, not evidence that any verification ran.
 */
export function candidateBindingIdentity(binding: BoundedLaunchCandidateBinding): string {
  if (binding.version !== 1) {
    throw new Error("unsupported candidate binding version");
  }
  for (const key of ["candidateDigest", "sourceDigest", "recipeDigest", "policyDigest"] as const) {
    requireText(binding[key], key);
  }
  return stableDigest({
    candidateDigest: binding.candidateDigest,
    sourceDigest: binding.sourceDigest,
    recipeDigest: binding.recipeDigest,
    policyDigest: binding.policyDigest,
    version: binding.version,
  });
}
