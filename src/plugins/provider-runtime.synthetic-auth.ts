import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolvePluginOwnedProviderAuthWith,
  resolveProviderAuthScope,
  type ProviderAuthScopeLookup,
} from "./provider-auth-scope.js";
import type { ResolveRuntimePluginDiscoveryProvidersParams } from "./provider-discovery.js";
import {
  resolvePluginDiscoveryProvidersRuntime,
  resolvePluginDiscoveryProvidersRuntimeAsync,
} from "./provider-discovery.runtime.js";
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
  ProviderDeferSyntheticProfileAuthContext,
  ProviderPlugin,
  ProviderResolveSyntheticAuthContext,
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
  return refs;
}

function matchesAnyProviderPluginRef(provider: ProviderPlugin, providerRefs: readonly string[]) {
  return providerRefs.some((providerRef) => matchesProviderPluginRef(provider, providerRef));
}

type ProviderSyntheticAuthParams = ProviderRuntimeLookup & {
  context: ProviderResolveSyntheticAuthContext;
  modelApi?: string;
};

type SyntheticAuthLookup =
  | {
      kind: "discovery";
      params: ResolveRuntimePluginDiscoveryProvidersParams;
      providerRefs: string[];
    }
  | { kind: "runtime"; providerRef: string };

/** Keep the scope and precedence identical for synchronous and async auth callers. */
function* syntheticAuthLookups(
  params: ProviderSyntheticAuthParams,
): Generator<SyntheticAuthLookup> {
  const providerRefs = resolveProviderHookRefs(
    params.provider,
    params.context.providerConfig,
    params.modelApi,
  );
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
  const discovery = (onlyPluginIds?: string[]): SyntheticAuthLookup => ({
    kind: "discovery",
    providerRefs,
    params: {
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      ...(onlyPluginIds ? { onlyPluginIds } : {}),
      discoveryEntriesOnly: true,
      includeSyntheticAuthProviders: true,
      includeManifestModelCatalogProviders: false,
    },
  });
  if (discoveryPluginIds.length > 0) {
    yield discovery(discoveryPluginIds);
  }
  for (const providerRef of providerRefs) {
    yield { kind: "runtime", providerRef };
  }
  if (discoveryPluginIds.length === 0 && providerRefs.length === 1) {
    // Custom provider aliases without a declared owner get an entries-only fallback.
    yield discovery();
  }
}

function findSyntheticAuthProvider(providers: ProviderPlugin[], refs: readonly string[]) {
  return providers.find(
    (provider) =>
      matchesAnyProviderPluginRef(provider, refs) &&
      Boolean(provider.resolveSyntheticAuth || provider.prepareSyntheticAuth),
  );
}

function resolveSyntheticAuthRuntimeProvider(
  params: ProviderSyntheticAuthParams,
  providerRef: string,
) {
  const provider = resolveProviderRuntimePlugin({
    ...params,
    provider: providerRef,
    applyAutoEnable: false,
  });
  return provider?.resolveSyntheticAuth || provider?.prepareSyntheticAuth ? provider : undefined;
}

function* resolveSyntheticAuthProviders(
  params: ProviderSyntheticAuthParams,
): Generator<ProviderPlugin> {
  for (const lookup of syntheticAuthLookups(params)) {
    if (lookup.kind === "discovery") {
      const provider = findSyntheticAuthProvider(
        resolvePluginDiscoveryProvidersRuntime(lookup.params),
        lookup.providerRefs,
      );
      if (provider) {
        yield provider;
        return;
      }
    } else {
      const provider = resolveSyntheticAuthRuntimeProvider(params, lookup.providerRef);
      if (provider) {
        yield provider;
      }
    }
  }
}

async function* resolveSyntheticAuthProvidersAsync(
  params: ProviderSyntheticAuthParams & { signal?: AbortSignal },
): AsyncGenerator<ProviderPlugin> {
  params.signal?.throwIfAborted();
  for (const lookup of syntheticAuthLookups(params)) {
    params.signal?.throwIfAborted();
    if (lookup.kind === "discovery") {
      const providers = await resolvePluginDiscoveryProvidersRuntimeAsync({
        ...lookup.params,
        signal: params.signal,
      });
      params.signal?.throwIfAborted();
      const provider = findSyntheticAuthProvider(providers, lookup.providerRefs);
      if (provider) {
        yield provider;
        return;
      }
    } else {
      const provider = resolveSyntheticAuthRuntimeProvider(params, lookup.providerRef);
      if (provider) {
        yield provider;
      }
    }
  }
}

export function resolvePluginOwnedProviderAuth(
  params: ProviderAuthScopeLookup & { profileId?: string; preferredProfile?: string },
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

type ProviderSyntheticAuthPreparationParams = ProviderSyntheticAuthParams &
  Parameters<typeof prepareSyntheticAuthWithProvider>[2];

async function prepareSyntheticAuthProviders(
  providers: Iterable<ProviderPlugin> | AsyncIterable<ProviderPlugin>,
  params: ProviderSyntheticAuthPreparationParams,
) {
  params.signal?.throwIfAborted();
  for await (const provider of providers) {
    params.signal?.throwIfAborted();
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
  return await prepareSyntheticAuthProviders(resolveSyntheticAuthProvidersAsync(params), params);
}

async function resolveExternalSyntheticAuthProviders(
  params: ProviderSyntheticAuthParams & { signal?: AbortSignal },
) {
  // Instance-owned credentials cannot become transferable worker bearer facts.
  if (resolveProviderAuthScope(params) === "plugin") {
    return [];
  }
  const providers: ProviderPlugin[] = [];
  for await (const provider of resolveSyntheticAuthProvidersAsync(params)) {
    providers.push(provider);
  }
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
    : await prepareSyntheticAuthProviders(
        await resolveExternalSyntheticAuthProviders(params),
        params,
      );
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
    const providers = await resolveExternalSyntheticAuthProviders({
      ...lookup,
      signal: params.signal,
    });
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
