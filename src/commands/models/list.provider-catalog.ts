import type { Api, Model } from "@mariozechner/pi-ai";
import { normalizeProviderId } from "../../agents/provider-id.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  resolvePluginDiscoveryProviders,
  runProviderStaticCatalog,
} from "../../plugins/provider-discovery.js";
import { resolveOwningPluginIdsForProvider } from "../../plugins/providers.js";

const DISCOVERY_ORDERS = ["simple", "profile", "paired", "late"] as const;
const SELF_HOSTED_DISCOVERY_PROVIDER_IDS = new Set(["lmstudio", "ollama", "sglang", "vllm"]);

function modelFromProviderCatalog(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
  model: ModelProviderConfig["models"][number];
}): Model<Api> {
  return {
    id: params.model.id,
    name: params.model.name || params.model.id,
    provider: params.provider,
    api: params.model.api ?? params.providerConfig.api ?? "openai-responses",
    baseUrl: params.providerConfig.baseUrl,
    reasoning: params.model.reasoning,
    input: params.model.input ?? ["text"],
    cost: params.model.cost,
    contextWindow: params.model.contextWindow,
    contextTokens: params.model.contextTokens,
    maxTokens: params.model.maxTokens,
    headers: params.model.headers,
    compat: params.model.compat,
  } as Model<Api>;
}

export async function loadProviderCatalogModelsForList(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  providerFilter?: string;
}): Promise<Model<Api>[]> {
  const env = params.env ?? process.env;
  const providerFilter = params.providerFilter ? normalizeProviderId(params.providerFilter) : "";
  const onlyPluginIds = providerFilter
    ? resolveOwningPluginIdsForProvider({
        provider: providerFilter,
        config: params.cfg,
        env,
      })
    : undefined;
  if (providerFilter && !onlyPluginIds) {
    return [];
  }
  const providers = await resolvePluginDiscoveryProviders({
    config: params.cfg,
    env,
    ...(onlyPluginIds ? { onlyPluginIds } : {}),
    includeUntrustedWorkspacePlugins: false,
  });
  const byOrder = groupPluginDiscoveryProvidersByOrder(providers);
  const rows: Model<Api>[] = [];
  const seen = new Set<string>();

  for (const order of DISCOVERY_ORDERS) {
    for (const provider of byOrder[order] ?? []) {
      if (!providerFilter && SELF_HOSTED_DISCOVERY_PROVIDER_IDS.has(provider.id)) {
        continue;
      }
      let result: Awaited<ReturnType<typeof runProviderStaticCatalog>> | null;
      try {
        result = await runProviderStaticCatalog({
          provider,
          config: params.cfg,
          agentDir: params.agentDir,
          env,
        });
      } catch {
        result = null;
      }
      const normalized = normalizePluginDiscoveryResult({ provider, result });
      for (const [providerIdRaw, providerConfig] of Object.entries(normalized)) {
        const providerId = normalizeProviderId(providerIdRaw);
        if (providerFilter && providerId !== providerFilter) {
          continue;
        }
        if (!providerId || !Array.isArray(providerConfig.models)) {
          continue;
        }
        for (const model of providerConfig.models) {
          const key = `${providerId}/${model.id}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          rows.push(
            modelFromProviderCatalog({
              provider: providerId,
              providerConfig,
              model,
            }),
          );
        }
      }
    }
  }

  return rows.toSorted((left, right) => {
    const provider = left.provider.localeCompare(right.provider);
    if (provider !== 0) {
      return provider;
    }
    return left.id.localeCompare(right.id);
  });
}
