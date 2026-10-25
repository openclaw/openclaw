import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";

function hasConfiguredCredentialValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value !== undefined && value !== null;
}

function hasConfiguredSearchCredentialCandidate(searchConfig: unknown): boolean {
  const record = asOptionalObjectRecord(searchConfig);
  if (!record) {
    return false;
  }
  return Object.entries(record).some(
    ([key, value]) => key !== "enabled" && hasConfiguredCredentialValue(value),
  );
}

function hasConfiguredPluginWebSearchCandidate(config: OpenClawConfig): boolean {
  const entries = asOptionalObjectRecord(config.plugins?.entries);
  if (!entries) {
    return false;
  }
  return Object.values(entries).some((entry) => {
    const pluginConfig = asOptionalObjectRecord(entry)?.config;
    return hasConfiguredSearchCredentialCandidate(asOptionalObjectRecord(pluginConfig)?.webSearch);
  });
}

function hasManifestWebSearchEnvCredentialCandidate(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = params.env;
  if (!env) {
    return false;
  }
  return loadManifestMetadataSnapshot({
    config: params.config,
    env,
  }).plugins.some((plugin) => {
    if (plugin.origin !== "bundled") {
      return false;
    }
    if ((plugin.contracts?.webSearchProviders?.length ?? 0) === 0) {
      return false;
    }
    const envVars = (plugin.setup?.providers ?? []).flatMap((provider) => provider.envVars ?? []);
    return envVars.some((envVar) => hasConfiguredCredentialValue(env[envVar]));
  });
}

export function hasConfiguredWebSearchCredential(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return (
    hasConfiguredSearchCredentialCandidate(params.config.tools?.web?.search) ||
    hasConfiguredPluginWebSearchCandidate(params.config) ||
    hasManifestWebSearchEnvCredentialCandidate(params)
  );
}
