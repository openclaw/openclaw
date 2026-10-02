import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  coerceSecretRef,
  isLegacySecretRefWithoutProvider,
  parseLegacySecretRefEnvMarker,
} from "../../../config/types.secrets.js";
import { setPathExistingStrict } from "../../../secrets/path-utils.js";
import { discoverConfigSecretTargets } from "../../../secrets/target-registry.js";

/** Normalize only registered credential paths before config validation and backup/write. */
export function migrateLegacySecretInputs(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  let next: OpenClawConfig | undefined;
  const changes: string[] = [];
  for (const target of discoverConfigSecretTargets(config)) {
    const original = target.value;
    const providerless = isLegacySecretRefWithoutProvider(original);
    const ref = providerless
      ? coerceSecretRef(target.value, config.secrets?.defaults)
      : parseLegacySecretRefEnvMarker(target.value, config.secrets?.defaults?.env);
    if (!ref) {
      continue;
    }
    next ??= structuredClone(config);
    const value = providerless ? { ...original, provider: ref.provider } : ref;
    if (setPathExistingStrict(next, target.pathSegments, value)) {
      changes.push(
        providerless
          ? `Added provider ${ref.provider} to ${target.path} SecretRef.`
          : `Moved ${target.path} ${String(target.value).trim()} marker → structured env SecretRef.`,
      );
    }
  }
  return { config: next ?? config, changes };
}
