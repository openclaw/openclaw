import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseSecretRef } from "../../config/types.secrets.js";

// Raw skill secret refs must not be replaced by redacted runtime snapshots.
function hasConfiguredSkillApiKeyRef(config?: OpenClawConfig): boolean {
  return Object.values(config?.skills?.entries ?? {}).some(
    (skillConfig) => parseSecretRef(skillConfig.apiKey) !== null,
  );
}

/** Chooses the runtime config snapshot unless it would hide skill secret refs. */
export function resolveSkillRuntimeConfig(config?: OpenClawConfig): OpenClawConfig | undefined {
  const runtimeConfig = getRuntimeConfigSnapshot();
  if (!runtimeConfig) {
    return config;
  }
  if (!config) {
    return runtimeConfig;
  }
  const runtimeHasRawSkillSecretRefs = hasConfiguredSkillApiKeyRef(runtimeConfig);
  const configHasRawSkillSecretRefs = hasConfiguredSkillApiKeyRef(config);
  if (runtimeHasRawSkillSecretRefs && !configHasRawSkillSecretRefs) {
    return config;
  }
  return runtimeConfig;
}
