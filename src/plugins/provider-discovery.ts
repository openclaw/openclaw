import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.js";
import { resolvePluginProviders } from "./providers.js";
import type { ProviderDiscoveryOrder, ProviderPlugin } from "./types.js";

const DISCOVERY_ORDER: readonly ProviderDiscoveryOrder[] = ["simple", "profile", "paired", "late"];

export function resolvePluginDiscoveryProviders(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderPlugin[] {
  return resolvePluginProviders(params).filter((provider) => provider.discovery);
}

export function groupPluginDiscoveryProvidersByOrder(
  providers: ProviderPlugin[],
): Record<ProviderDiscoveryOrder, ProviderPlugin[]> {
  const grouped = {
    simple: [],
    profile: [],
    paired: [],
    late: [],
  } as Record<ProviderDiscoveryOrder, ProviderPlugin[]>;

  for (const provider of providers) {
    const order = provider.discovery?.order ?? "late";
    grouped[order].push(provider);
  }

  for (const order of DISCOVERY_ORDER) {
    grouped[order].sort((a, b) => a.label.localeCompare(b.label));
  }

  return grouped;
}

export function normalizePluginDiscoveryResult(params: {
  provider: ProviderPlugin;
  result:
    | { provider: ModelProviderConfig }
    | { providers: Record<string, ModelProviderConfig> }
    | null
    | undefined;
}): Record<string, ModelProviderConfig> {
  const result = params.result;
  if (!result) {
    return {};
  }

  if ("provider" in result) {
    return { [normalizeProviderId(params.provider.id)]: result.provider };
  }

  const normalized: Record<string, ModelProviderConfig> = {};
  for (const [key, value] of Object.entries(result.providers)) {
    const normalizedKey = normalizeProviderId(key);
    if (!normalizedKey || !value) {
      continue;
    }
    normalized[normalizedKey] = value;
  }
  return normalized;
}
