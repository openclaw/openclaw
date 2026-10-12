import { isDeepStrictEqual } from "node:util";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
// Maintains config metadata fields written alongside user config.
import { VERSION } from "../version.js";
import { materializeModelPolicyAllowlist } from "./model-policy-allowlist-migration.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { materializeUtilityModelSeparation } from "./utility-model-separation-migration.js";

/** Metadata keys automatically stamped on config writes. */
export const AUTO_MANAGED_CONFIG_META_PATHS = [
  ["meta", "lastTouchedVersion"],
  ["meta", "migrations", "modelPolicyAllowlist"],
  ["meta", "migrations", "utilityModelSeparation"],
] as const;

export function stampConfigWriteMetadata(
  cfg: OpenClawConfig,
  _now: string = new Date().toISOString(),
  version: string = VERSION,
  previousConfig?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawConfig {
  const migrationStamped =
    previousConfig === undefined
      ? cfg
      : materializeUtilityModelSeparation(
          materializeModelPolicyAllowlist(cfg, previousConfig).config,
          previousConfig,
        ).config;
  if (resolveUpdateRehearsalRoot(env)) {
    // Released drivers compare this copy before activation. Keep real migrations,
    // but leave writer-only stamps for the subsequent live config write.
    const { meta: beforeMeta, ...before } = cfg;
    const { meta: afterMeta, ...after } = migrationStamped;
    const removedMarker =
      (beforeMeta?.migrations?.modelPolicyAllowlist &&
        !afterMeta?.migrations?.modelPolicyAllowlist) ||
      (beforeMeta?.migrations?.utilityModelSeparation &&
        !afterMeta?.migrations?.utilityModelSeparation);
    return !removedMarker && isDeepStrictEqual(before, after) ? cfg : migrationStamped;
  }
  return {
    ...migrationStamped,
    meta: {
      ...migrationStamped.meta,
      lastTouchedVersion: version,
    },
  };
}

/** Persist machine-owned metadata only after the matching config file commit succeeds. */
export function recordConfigWriteMetadata(
  now: string = new Date().toISOString(),
  _version: string = VERSION,
): void {
  writeConfigMachineState("config.lastTouchedAt", now);
}
