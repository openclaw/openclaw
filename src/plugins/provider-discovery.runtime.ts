import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginProviders } from "./providers.runtime.js";
import type { ProviderPlugin } from "./types.js";

export function resolvePluginDiscoveryProvidersRuntime(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
}): ProviderPlugin[] {
  return resolvePluginProviders({
    ...params,
    bundledProviderAllowlistCompat: true,
  });
}
