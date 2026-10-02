/** Detects legacy SecretRef env markers in config values. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isLegacySecretRefEnvMarker,
  parseLegacySecretRefEnvMarker,
} from "../config/types.secrets.js";
import { setPathExistingStrict } from "./path-utils.js";
import { discoverConfigSecretTargets } from "./target-registry.js";

/**
 * Converts parseable legacy env marker strings into structured env SecretRef objects.
 */
export function migrateLegacySecretRefEnvMarkers(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const candidates = discoverConfigSecretTargets(config).flatMap((target) => {
    if (!isLegacySecretRefEnvMarker(target.value)) {
      return [];
    }
    const ref = parseLegacySecretRefEnvMarker(target.value, config.secrets?.defaults?.env);
    return ref
      ? [{ path: target.path, pathSegments: target.pathSegments, value: target.value.trim(), ref }]
      : [];
  });
  if (candidates.length === 0) {
    return { config, changes: [] };
  }

  const next = structuredClone(config) as OpenClawConfig & Record<string, unknown>;
  const changes: string[] = [];
  for (const candidate of candidates) {
    // Only registered existing paths are rewritten; malformed markers remain for explicit repair.
    if (setPathExistingStrict(next, candidate.pathSegments, candidate.ref)) {
      changes.push(`Moved ${candidate.path} ${candidate.value} marker → structured env SecretRef.`);
    }
  }
  return { config: next, changes };
}
