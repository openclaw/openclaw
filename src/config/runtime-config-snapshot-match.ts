// Config-snapshot comparison: byte-stable serialization plus resolution provenance.
import { isDeepStrictEqual } from "node:util";
import { getConfigResolutionFacts, serializeConfigResolutionFacts } from "./resolution-facts.js";
import type { OpenClawConfig } from "./types.js";

/** Serialize a value with object keys sorted, so equal data always yields the same bytes. */
export function stableConfigStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableConfigStringify(entry)).join(",")}]`;
  }
  // SAFETY: the guards above establish `value` is a non-null, non-array object, so its own properties are string-keyed.
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableConfigStringify(record[key])}`)
    .join(",")}}`;
}

export function configSnapshotsMatch(left: OpenClawConfig, right: OpenClawConfig): boolean {
  if (left === right) {
    return true;
  }
  // Fresh reads allocate new facts. Compare their complete provenance, not object identity
  // or just JSON config bytes: same-byte values can name different authored SecretRefs.
  if (
    getConfigResolutionFacts(left) !== getConfigResolutionFacts(right) &&
    !isDeepStrictEqual(serializeConfigResolutionFacts(left), serializeConfigResolutionFacts(right))
  ) {
    return false;
  }
  try {
    return stableConfigStringify(left) === stableConfigStringify(right);
  } catch {
    return false;
  }
}
