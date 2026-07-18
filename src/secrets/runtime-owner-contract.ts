/** Process-local identity for the non-secret config that an owner may use with a credential. */
import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";

/**
 * Binds last-known-good credentials to their complete owner config. The digest is
 * process-local metadata only; raw config and credential-bearing values are never logged.
 */
export function digestSecretOwnerContract(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** Combines assignment fragments into one deterministic owner contract. */
export function combineSecretOwnerContractDigests(digests: readonly string[]): string | undefined {
  const unique = [...new Set(digests)].toSorted();
  return unique.length > 0 ? digestSecretOwnerContract(unique) : undefined;
}
