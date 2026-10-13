import { isDeepStrictEqual } from "node:util";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import { writeConfigMachineStateAsync } from "../state/config-machine-state-async.js";
// Maintains config metadata fields written alongside user config.
import { VERSION } from "../version.js";
import { getConfigValueAtPath, unsetConfigValueAtPath } from "./config-paths.js";
import { materializeModelPolicyAllowlist } from "./model-policy-allowlist-migration.js";
import { cloneConfigWithResolutionFacts } from "./resolution-facts.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { materializeUtilityModelSeparation } from "./utility-model-separation-migration.js";

/** Metadata keys automatically stamped on config writes. */
export const AUTO_MANAGED_CONFIG_META_PATHS = [
  ["meta", "lastTouchedVersion"],
  ["meta", "migrations", "modelPolicyAllowlist"],
  ["meta", "migrations", "utilityModelSeparation"],
] as const;

export function hasWebhookMigrationProgress(
  previous: OpenClawConfig,
  next: OpenClawConfig,
): boolean {
  const before = previous.meta?.migrations?.webhookListeners;
  const after = next.meta?.migrations?.webhookListeners;
  return before !== true && after !== undefined && !isDeepStrictEqual(before, after);
}

/** Publish migration pins beside includes so the root marker and pins roll back together. */
export function projectWebhookMigrationIncludeWrite(
  previous: OpenClawConfig,
  next: OpenClawConfig,
) {
  if (!hasWebhookMigrationProgress(previous, next)) {
    return undefined;
  }
  const completed = next.meta?.migrations?.webhookListeners;
  const before = previous.meta?.migrations?.webhookListeners;
  const paths = Object.entries(completed === true ? {} : (completed ?? {})).flatMap(
    ([channelId, fields]) =>
      typeof before === "object" && Object.hasOwn(before, channelId)
        ? []
        : fields.filter((field) => {
            const value = getConfigValueAtPath(next, field);
            return (
              field[0] === "channels" &&
              field[1] === channelId &&
              (field.length === 3 || (field.length === 5 && field[2] === "accounts")) &&
              getConfigValueAtPath(previous, field) === undefined &&
              (field.at(-1) === "legacyWebhook"
                ? asNullableRecord(value) !== null
                : field.at(-1) === "enabled" && value === true)
            );
          }),
  );
  const config = cloneConfigWithResolutionFacts(next);
  for (const field of paths) {
    unsetConfigValueAtPath(config, field, previous);
  }
  return { config, paths };
}

export function stampConfigWriteMetadata(
  cfg: OpenClawConfig,
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
export async function recordConfigWriteMetadata(
  now: string = new Date().toISOString(),
): Promise<void> {
  await writeConfigMachineStateAsync("config.lastTouchedAt", now);
}
