import type { Api, Model } from "@mariozechner/pi-ai";
import { normalizeProviderId } from "../../agents/provider-id.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  resolvePluginDiscoveryProviders,
  runProviderStaticCatalog,
} from "../../plugins/provider-discovery.js";
import {
  resolveDiscoveredProviderPluginIds,
  resolveOwningPluginIdsForProvider,
} from "../../plugins/providers.js";
import type { ProviderPlugin } from "../../plugins/types.js";

const DISCOVERY_ORDERS = ["simple", "profile", "paired", "late"] as const;
const SELF_HOSTED_DISCOVERY_PROVIDER_IDS = new Set(["lmstudio", "ollama", "sglang", "vllm"]);
const STATIC_CATALOG_TIMEOUT_MS = 2_000;
const log = createSubsystemLogger("models/list-provider-catalog");

function providerMatchesFilterAlias(provider: ProviderPlugin, providerFilter: string): boolean {
  return [provider.id, ...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
    (providerId) => normalizeProviderId(providerId) === providerFilter,
  );
}

async function resolveWorkspacePluginIdsForProviderAlias(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  providerFilter: string;
}): Promise<string[] | undefined> {
  const discoverablePluginIds = new Set(
    resolveDiscoveredProviderPluginIds({
      config: params.cfg,
      env: params.env,
      includeUntrustedWorkspacePlugins: false,
    }),
  );
  const workspacePluginIds = loadPluginManifestRegistry({
    config: params.cfg,
    env: params.env,
  })
    .plugins.filter(
      (plugin) => plugin.origin === "workspace" && discoverablePluginIds.has(plugin.id),
    )
    .map((plugin) => plugin.id);
  if (workspacePluginIds.length === 0) {
    return undefined;
  }

  const providers = await resolvePluginDiscoveryProviders({
    config: params.cfg,
    env: params.env,
    onlyPluginIds: workspacePluginIds,
    includeUntrustedWorkspacePlugins: false,
  });
  const pluginIds = [
    ...new Set(
      providers
        .filter((provider) => providerMatchesFilterAlias(provider, params.providerFilter))
        .map((provider) => provider.pluginId)
        .filter((pluginId): pluginId is string => typeof pluginId === "string" && pluginId !== ""),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
  return pluginIds.length > 0 ? pluginIds : undefined;
}

export async function resolveProviderCatalogPluginIdsForFilter(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  providerFilter: string;
}): Promise<string[] | undefined> {
  const providerFilter = normalizeProviderId(params.providerFilter);
  if (!providerFilter) {
    return undefined;
  }
  const manifestPluginIds = resolveOwningPluginIdsForProvider({
    provider: providerFilter,
    config: params.cfg,
    env: params.env,
  });
  if (manifestPluginIds) {
    return manifestPluginIds;
  }
  const { resolveProviderContractPluginIdsForProviderAlias } =
    await import("../../plugins/contracts/registry.js");
  const bundledAliasPluginIds = resolveProviderContractPluginIdsForProviderAlias(providerFilter);
  if (bundledAliasPluginIds) {
    return bundledAliasPluginIds;
  }
  return await resolveWorkspacePluginIdsForProviderAlias({
    cfg: params.cfg,
    env: params.env,
    providerFilter,
  });
}

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

async function withStaticCatalogTimeout<T>(
  providerId: string,
  run: () => T | Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `provider static catalog timed out for ${providerId} after ${STATIC_CATALOG_TIMEOUT_MS}ms`,
        ),
      );
    }, STATIC_CATALOG_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.resolve().then(run), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
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
    ? await resolveProviderCatalogPluginIdsForFilter({
        cfg: params.cfg,
        env,
        providerFilter,
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
        result = await withStaticCatalogTimeout(provider.id, () =>
          runProviderStaticCatalog({
            provider,
            config: params.cfg,
            agentDir: params.agentDir,
            env,
          }),
        );
      } catch (error) {
        log.warn(`provider static catalog failed for ${provider.id}: ${formatErrorMessage(error)}`);
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
