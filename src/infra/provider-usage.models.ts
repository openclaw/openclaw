import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function captureModelBaseUrls(snapshot: PreparedModelRuntimeSnapshot) {
  const registry = snapshot.createStores().modelRegistry;
  if (!snapshot.isCurrent() || registry.getError()) {
    return undefined;
  }
  const providers = new Map<string, Set<string>>();
  // Static manifest models can live only in the prepared catalog. Retain its
  // physical variants and authored registry routes; logical deduplication must
  // not erase a custom endpoint before the credential-family policy sees it.
  for (const model of [
    ...registry.getAll(),
    ...snapshot.modelCatalog.entries,
    ...snapshot.modelCatalog.routeVariants,
  ]) {
    const provider = normalizeProviderId(model.provider);
    const urls = providers.get(provider) ?? new Set<string>();
    urls.add(model.baseUrl ?? "");
    providers.set(provider, urls);
  }
  return providers;
}

/** Usage auth and HTTP share one agent-owned route snapshot, without loading credentials. */
export function createUsageModelBaseUrlResolver(params: {
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  providerIds: readonly string[];
}) {
  let pending: Promise<ReturnType<typeof captureModelBaseUrls>> | undefined;
  const prepare = async (providerIds: readonly string[], signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const { getAgentDir } = await import("../agents/config.js");
    const { acquireReadOnlyPreparedModelRuntime, getPreparedModelRuntimeSnapshot } =
      await import("../agents/prepared-model-runtime.js");
    const { preparedModelRuntimeConfigsMatch } =
      await import("../agents/prepared-model-runtime.owner.js");
    const input = { ...params, agentDir: params.agentDir ?? getAgentDir() };
    const published = getPreparedModelRuntimeSnapshot(input);
    if (published && preparedModelRuntimeConfigsMatch(published.config, params.config)) {
      const routes = captureModelBaseUrls(published);
      if (!routes || providerIds.some((provider) => routes.has(normalizeProviderId(provider)))) {
        return routes;
      }
    }
    const { loadManifestMetadataSnapshot } =
      await import("../plugins/manifest-contract-eligibility.js");
    const { readManifestProviderDefaultModelRef } = await import("../plugins/provider-catalog.js");
    const metadata = loadManifestMetadataSnapshot(params);
    const requested = new Set([...params.providerIds, ...providerIds].map(normalizeProviderId));
    // Usage can be requested for a credential whose provider is not the agent's
    // default. Select declared static models without synthesizing an inference ref.
    const runtimePluginSelections = metadata.plugins.flatMap((plugin) =>
      Object.keys(plugin.modelCatalog?.providers ?? {}).flatMap((provider) => {
        const ref = requested.has(normalizeProviderId(provider))
          ? readManifestProviderDefaultModelRef(plugin, provider)
          : undefined;
        const parsed = ref ? parseModelCatalogRef(ref) : undefined;
        return parsed ? [parsed] : [];
      }),
    );
    await using lease = await acquireReadOnlyPreparedModelRuntime(
      {
        ...input,
        skipCredentials: true,
        runtimePluginPurpose: "model-catalog",
        runtimePluginSelections,
      },
      { catalogMode: "static", abortSignal: signal },
    );
    signal?.throwIfAborted();
    return captureModelBaseUrls(lease.snapshot);
  };
  return async (
    providerIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly string[] | undefined> => {
    // Resolve once per collection, never once per provider or again after auth.
    const routes = await (pending ??= prepare(providerIds, signal));
    signal?.throwIfAborted();
    const urls = [
      ...new Set(
        providerIds.flatMap((provider) => [...(routes?.get(normalizeProviderId(provider)) ?? [])]),
      ),
    ];
    return urls.length ? urls.toSorted() : undefined;
  };
}
