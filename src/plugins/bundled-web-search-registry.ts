import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginWebSearchProviders } from "./web-search-providers.runtime.js";

function hasConfiguredCredentialValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value !== undefined && value !== null;
}

export function hasBundledWebSearchCredential(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  searchConfig?: Record<string, unknown>;
}): boolean {
  const searchConfig =
    params.searchConfig ??
    (params.config.tools?.web?.search as Record<string, unknown> | undefined);
  return resolvePluginWebSearchProviders({
    config: params.config,
    env: params.env,
    bundledAllowlistCompat: true,
    origin: "bundled",
  }).some((provider) => {
    const configuredCredential =
      provider.getConfiguredCredentialValue?.(params.config) ??
      provider.getCredentialValue(searchConfig);
    if (hasConfiguredCredentialValue(configuredCredential)) {
      return true;
    }
    return provider.envVars.some((envVar) => hasConfiguredCredentialValue(params.env?.[envVar]));
  });
}
