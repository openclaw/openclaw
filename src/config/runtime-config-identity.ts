// Config identity comparison and applicable runtime-config selection helpers.
import { isDeepStrictEqual } from "node:util";
import { getConfigResolutionFacts, serializeConfigResolutionFacts } from "./resolution-facts.js";
import type { OpenClawConfig } from "./types.js";

export function stableConfigStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableConfigStringify(entry)).join(",")}]`;
  }
  // SAFETY: non-null non-array object narrowed above; config snapshots are plain JSON data.
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

export function selectApplicableRuntimeConfig(params: {
  inputConfig?: OpenClawConfig;
  runtimeConfig?: OpenClawConfig | null;
  runtimeSourceConfig?: OpenClawConfig | null;
}): OpenClawConfig | undefined {
  const runtimeConfig = params.runtimeConfig ?? null;
  if (!runtimeConfig) {
    return params.inputConfig;
  }
  const inputConfig = params.inputConfig;
  if (!inputConfig) {
    return runtimeConfig;
  }
  if (inputConfig === runtimeConfig) {
    return inputConfig;
  }
  const runtimeSourceConfig = params.runtimeSourceConfig ?? null;
  // A pinned file config is not an activated secrets snapshot. Without its source
  // contract, replacing an explicit config can discard command-resolved credentials.
  if (runtimeSourceConfig && configSnapshotsMatch(inputConfig, runtimeSourceConfig)) {
    return runtimeConfig;
  }
  return inputConfig;
}
