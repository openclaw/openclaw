/** Owns synthetic-auth discovery, live reads and external fact preparation. */
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveProviderAuthScope,
  resolvePluginOwnedProviderAuthWith,
} from "./provider-auth-scope.js";
import { resolvePluginDiscoveryProvidersRuntime } from "./provider-discovery.runtime.js";
import { resolveProviderRuntimePlugin } from "./provider-hook-runtime.js";
import { matchesProviderPluginRef } from "./provider-registry-shared.js";
import {
  prepareSyntheticAuthWithProvider,
  readPreparedSyntheticAuthFact,
  resolveSyntheticAuthWithProvider,
  type PreparedSyntheticAuthFact,
  type PreparedSyntheticAuthFacts,
} from "./provider-synthetic-auth.js";
import { resolveOwningPluginIdsForProviderRef } from "./providers.js";
import type {
  ProviderPlugin,
  ProviderResolveSyntheticAuthContext,
  ProviderDeferSyntheticProfileAuthContext,
} from "./types.js";
type ProviderRuntimeLookup = Pick<
  Parameters<typeof resolveProviderRuntimePlugin>[0],
  "provider" | "config" | "workspaceDir" | "env"
>;

function resolveProviderHookRefs(
  provider: string,
  providerConfig?: ModelProviderConfig,
  modelApi?: string,
): string[] {
  const refs = [provider];
  const apiRef = normalizeOptionalString(modelApi ?? providerConfig?.api);
  if (apiRef && normalizeProviderId(apiRef) !== normalizeProviderId(provider)) {
    refs.push(apiRef);
  }
  return uniqueStrings(refs);
}

type ProviderSyntheticAuthParams = ProviderRuntimeLookup & {
  context: ProviderResolveSyntheticAuthContext;
  modelApi?: string;
};

function* resolveSyntheticAuthProviders(
  params: ProviderSyntheticAuthParams,
): Generator<ProviderPlugin> {
  const providerRefs = resolveProviderHookRefs(
    params.provider,
    params.context.providerConfig,
    params.modelApi,
  );
  const matchesSyntheticAuthProvider = (provider: ProviderPlugin) =>
    providerRefs.some((ref) => matchesProviderPluginRef(provider, ref)) &&
    Boolean(provider.resolveSyntheticAuth || provider.prepareSyntheticAuth);
  const discoveryPluginIds = [
    ...new Set(
      providerRefs.flatMap(
        (provider) =>
          resolveOwningPluginIdsForProviderRef({
            provider,
            config: params.config,
            workspaceDir: params.workspaceDir,
            env: params.env,
          }) ?? [],
      ),
    ),
  ];
  const discoveryProvider = (
    discoveryPluginIds.length > 0
      ? resolvePluginDiscoveryProvidersRuntime({
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: params.env,
          onlyPluginIds: discoveryPluginIds,
          discoveryEntriesOnly: true,
          includeSyntheticAuthProviders: true,
          includeManifestModelCatalogProviders: false,
        })
      : []
  ).find(matchesSyntheticAuthProvider);
  if (discoveryProvider) {
    yield discoveryProvider;
    return;
  }
  for (const providerRef of providerRefs) {
    const provider = resolveProviderRuntimePlugin({
      ...params,
      provider: providerRef,
      applyAutoEnable: false,
    });
    if (provider?.resolveSyntheticAuth || provider?.prepareSyntheticAuth) {
      yield provider;
    }
  }
  if (discoveryPluginIds.length === 0 && providerRefs.length === 1) {
    // Last-resort match for custom provider ids with no resolvable owning plugin (e.g. Ollama
    // aliases). Entry modules only: a full plugin-runtime sweep here costs seconds per ref on
    // source checkouts and belongs to explicit control-plane loads.
    const fallbackProvider = resolvePluginDiscoveryProvidersRuntime({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      discoveryEntriesOnly: true,
      includeSyntheticAuthProviders: true,
      includeManifestModelCatalogProviders: false,
    }).find(matchesSyntheticAuthProvider);
    if (fallbackProvider) {
      yield fallbackProvider;
    }
  }
}

/** Normal runtime facade for the shared cold-safe live credential owner. */
export function resolvePluginOwnedProviderAuth(
  params: ProviderSyntheticAuthParams & { profileId?: string; preferredProfile?: string },
) {
  return resolvePluginOwnedProviderAuthWith(params, resolveProviderRuntimePlugin);
}

export function resolveProviderSyntheticAuthWithPlugin(params: ProviderSyntheticAuthParams) {
  if (resolveProviderAuthScope(params) === "plugin") {
    return resolvePluginOwnedProviderAuth(params);
  }
  const captured = readPreparedSyntheticAuthFact(params.context, params);
  if (captured) {
    return captured.result ?? undefined;
  }
  for (const provider of resolveSyntheticAuthProviders(params)) {
    const resolved = resolveSyntheticAuthWithProvider(provider, params.context, params);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

type ProviderSyntheticAuthPreparationParams = ProviderSyntheticAuthParams & {
  signal?: AbortSignal;
};

async function prepareSyntheticAuthProviders(
  providers: Iterable<ProviderPlugin>,
  params: ProviderSyntheticAuthPreparationParams & { preparationOwner?: object },
) {
  params.signal?.throwIfAborted();
  for (const provider of providers) {
    const resolved = await prepareSyntheticAuthWithProvider(provider, params.context, params);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

export async function prepareProviderSyntheticAuthWithPlugin(
  params: ProviderSyntheticAuthPreparationParams,
) {
  params.signal?.throwIfAborted();
  if (resolveProviderAuthScope(params) === "plugin") {
    return resolvePluginOwnedProviderAuth(params);
  }
  const captured = readPreparedSyntheticAuthFact(params.context, params);
  if (captured) {
    return captured.result ?? undefined;
  }
  return await prepareSyntheticAuthProviders(resolveSyntheticAuthProviders(params), params);
}

function resolveExternalSyntheticAuthProviders(params: ProviderSyntheticAuthParams) {
  if (resolveProviderAuthScope(params) === "plugin") {
    return [];
  }
  const providers = [...resolveSyntheticAuthProviders(params)];
  return providers.some((provider) => provider.prepareSyntheticAuth) ? providers : [];
}

/** Prepare external checks without evaluating pure-only hooks before their synchronous read. */
export async function prepareProviderExternalAuthWithPlugin(
  params: ProviderSyntheticAuthPreparationParams,
) {
  params.signal?.throwIfAborted();
  if (resolveProviderAuthScope(params) === "plugin") {
    return resolvePluginOwnedProviderAuth(params);
  }
  const captured = readPreparedSyntheticAuthFact(params.context, params);
  return captured
    ? (captured.result ?? undefined)
    : await prepareSyntheticAuthProviders(resolveExternalSyntheticAuthProviders(params), params);
}

/** Capture a fresh, complete external-auth generation before dispatching read-only worker work. */
export async function captureProviderSyntheticAuthFacts(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  providerRefs: Iterable<string>;
  signal?: AbortSignal;
}): Promise<PreparedSyntheticAuthFacts> {
  const preparationOwner = {};
  const facts: PreparedSyntheticAuthFact[] = [];
  const providerRefs = [...new Set([...params.providerRefs].map(normalizeProviderId))].toSorted();
  for (const provider of providerRefs) {
    params.signal?.throwIfAborted();
    const lookup = {
      provider,
      config: params.config,
      env: params.env,
      workspaceDir: params.workspaceDir,
      context: {
        config: params.config,
        provider,
        providerConfig: findNormalizedProviderValue(params.config.models?.providers, provider),
      },
    };
    const providers = resolveExternalSyntheticAuthProviders(lookup);
    if (providers.length === 0) {
      continue;
    }
    const result = await prepareSyntheticAuthProviders(providers, {
      ...lookup,
      signal: params.signal,
      preparationOwner,
    });
    facts.push(
      Object.freeze({
        providerRef: provider,
        result: result ? Object.freeze({ ...result }) : null,
      }),
    );
  }
  params.signal?.throwIfAborted();
  return Object.freeze(facts);
}

export function shouldDeferProviderSyntheticProfileAuthWithPlugin(
  params: ProviderRuntimeLookup & {
    context: ProviderDeferSyntheticProfileAuthContext;
    modelApi?: string;
  },
) {
  const providerRefs = resolveProviderHookRefs(
    params.provider,
    params.context.providerConfig,
    params.modelApi,
  );
  for (const providerRef of providerRefs) {
    const resolved = resolveProviderRuntimePlugin({
      ...params,
      provider: providerRef,
    })?.shouldDeferSyntheticProfileAuth?.(params.context);
    if (resolved !== undefined) {
      return resolved;
    }
  }
  return undefined;
}
