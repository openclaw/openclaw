import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { getRuntimeConfigSnapshot, getRuntimeConfigSourceSnapshot } from "./runtime-snapshot.js";
import { projectRuntimeChangesOntoSource } from "./source-value-projection.js";
import type { OpenClawConfig } from "./types.js";

/** Projects a runtime-derived config back onto the active authored source snapshot. */
export function projectConfigOntoRuntimeSourceSnapshot(config: OpenClawConfig): OpenClawConfig {
  const runtimeConfigSnapshot = getRuntimeConfigSnapshot();
  const runtimeConfigSourceSnapshot = getRuntimeConfigSourceSnapshot();
  if (!runtimeConfigSnapshot || !runtimeConfigSourceSnapshot) {
    return config;
  }
  if (config === runtimeConfigSnapshot) {
    return runtimeConfigSourceSnapshot;
  }
  // SAFETY: runtime snapshots are opaque config objects; record view is intentional for key-wise diffing.
  const runtime = runtimeConfigSnapshot as Record<string, unknown>;
  // SAFETY: candidate is the incoming config being projected; record view is for structural comparison.
  const candidate = config as Record<string, unknown>;
  for (const key of Object.keys(runtime)) {
    if (!Object.hasOwn(candidate, key)) {
      return config;
    }
    const runtimeValue = runtime[key];
    const candidateValue = candidate[key];
    if (
      Array.isArray(runtimeValue) !== Array.isArray(candidateValue) ||
      (runtimeValue === null) !== (candidateValue === null) ||
      typeof runtimeValue !== typeof candidateValue
    ) {
      return config;
    }
  }
  return projectRuntimeChangesOntoSource(
    runtimeConfigSourceSnapshot,
    runtimeConfigSnapshot,
    config,
  ) as OpenClawConfig; // SAFETY: projection restores source-typed shape; cast recovers OpenClawConfig
}

/** Projects partial legacy inputs without persisting deleted runtime-only parents. */
export function projectLegacyRuntimeConfigWrite(
  config: OpenClawConfig,
  runtimeSnapshot = getRuntimeConfigSnapshot(),
  sourceSnapshot = getRuntimeConfigSourceSnapshot(),
): OpenClawConfig {
  if (!runtimeSnapshot || !sourceSnapshot) {
    return config;
  }
  // Legacy partial writes alone omit parents created only by removing runtime defaults.
  return (asOptionalRecord(
    projectRuntimeChangesOntoSource(sourceSnapshot, runtimeSnapshot, config, {
      pruneUnauthoredDeletions: true,
    }),
  ) ?? {}) as OpenClawConfig; // SAFETY: projection returns source-shaped record; cast restores OpenClawConfig after optional unwrap
}
