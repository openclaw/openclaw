import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { collectManifestModelIdNormalizationPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginManifestProviderEndpoint } from "./manifest.js";
import { listOfficialExternalProviderEndpointManifests } from "./official-external-provider-endpoints.js";
import type {
  PluginProviderAuthAliasCandidate,
  PluginProviderAuthContribution,
} from "./plugin-metadata-snapshot.types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { collectPluginProviderRequestOwners } from "./plugin-provider-request-policy.js";
import { listSetupProviderIds } from "./setup-descriptors.js";

const PROVIDER_ENDPOINT_CLASSES = new Set(
  "anthropic-public cerebras-native chutes-native deepseek-native github-copilot-native groq-native meta-native mistral-public minimax-native moonshot-native modelstudio-native novita-native nvidia-native openai-public openai opencode-native opencode-go-native azure-openai openrouter vercel-ai-gateway xai-native xiaomi-native zai-native google-generative-ai google-vertex".split(
    " ",
  ),
);

function normalizeProviderHosts(value: unknown): string[] {
  return normalizeTrimmedStringList(value).map((entry) => entry.toLowerCase());
}

export function normalizePluginProviderBaseUrl(value: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  const schemeless = trimmed && /^[a-z0-9.[\]-]+(?::\d+)?(?:[/?#].*)?$/i.test(trimmed);
  const url = trimmed ? URL.parse(schemeless ? `https://${trimmed}` : trimmed) : null;
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return undefined;
  }
  url.hash = "";
  url.search = "";
  return normalizeOptionalLowercaseString(url.toString().replace(/\/+$/, ""));
}

function hostMatchesSuffix(host: string, suffix: string): boolean {
  if (!suffix) {
    return false;
  }
  return suffix.startsWith(".") || suffix.startsWith("-")
    ? host.endsWith(suffix)
    : host === suffix || host.endsWith(`.${suffix}`);
}

/** Matches endpoint facts normalized by their metadata or catalog preparation owner. */
export function matchesPluginProviderEndpoint(
  endpoint: PluginManifestProviderEndpoint,
  params: {
    host: string;
    normalizedBaseUrl?: string;
  },
): boolean {
  return (
    (endpoint.hosts ?? []).includes(params.host) ||
    (endpoint.hostSuffixes ?? []).some((suffix) => hostMatchesSuffix(params.host, suffix)) ||
    Boolean(params.normalizedBaseUrl && endpoint.baseUrls?.includes(params.normalizedBaseUrl))
  );
}

export function prepareProviderEndpoints(value: unknown): PluginManifestProviderEndpoint[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const endpoints: PluginManifestProviderEndpoint[] = [];
  for (const endpoint of value) {
    if (!isRecord(endpoint)) {
      continue;
    }
    const endpointClass = normalizeOptionalString(endpoint.endpointClass);
    if (!endpointClass) {
      continue;
    }
    const googleVertexRegion = normalizeOptionalString(endpoint.googleVertexRegion);
    const googleVertexRegionHostSuffix = normalizeOptionalString(
      endpoint.googleVertexRegionHostSuffix,
    )?.toLowerCase();
    endpoints.push({
      endpointClass,
      hosts: normalizeProviderHosts(endpoint.hosts),
      hostSuffixes: normalizeProviderHosts(endpoint.hostSuffixes),
      baseUrls: normalizeProviderHosts(endpoint.baseUrls)
        .map(normalizePluginProviderBaseUrl)
        .filter((baseUrl): baseUrl is string => baseUrl !== undefined),
      ...(googleVertexRegion ? { googleVertexRegion } : {}),
      ...(googleVertexRegionHostSuffix ? { googleVertexRegionHostSuffix } : {}),
    });
  }
  return endpoints;
}

const PROVIDER_AUTH_ALIAS_ORIGIN_PRIORITY: Readonly<Record<PluginOrigin, number>> = {
  config: 0,
  bundled: 1,
  global: 2,
  workspace: 3,
};

/** Prepares package alias candidates without capturing current workspace trust. */
export function buildPluginMetadataProviderAuthAliases(plugins: readonly PluginManifestRecord[]) {
  const aliases = new Map<string, PluginProviderAuthAliasCandidate[]>();
  let order = 0;
  for (const plugin of plugins) {
    const entries = [
      ...Object.entries(plugin.providerAuthAliases ?? {}).toSorted(([left], [right]) =>
        left.localeCompare(right),
      ),
      ...(plugin.providerAuthChoices ?? []).flatMap((choice) =>
        (choice.deprecatedChoiceIds ?? []).map((alias) => [alias, choice.provider] as const),
      ),
    ];
    for (const [rawAlias, rawTarget] of entries) {
      const alias = normalizeProviderId(rawAlias);
      const target = normalizeProviderId(
        typeof rawTarget === "string" ? rawTarget : rawTarget.provider,
      );
      if (!alias || !target) {
        continue;
      }
      const candidates = aliases.get(alias) ?? [];
      candidates.push({
        plugin,
        target,
        ...(typeof rawTarget === "string" ? {} : { baseUrls: rawTarget.baseUrls }),
        order: order++,
      });
      aliases.set(alias, candidates);
    }
  }
  for (const candidates of aliases.values()) {
    candidates.sort(
      (left, right) =>
        (PROVIDER_AUTH_ALIAS_ORIGIN_PRIORITY[left.plugin.origin] ?? Number.MAX_SAFE_INTEGER) -
        (PROVIDER_AUTH_ALIAS_ORIGIN_PRIORITY[right.plugin.origin] ?? Number.MAX_SAFE_INTEGER),
    );
  }
  return aliases;
}

export function buildPluginMetadataProviderFacts(
  plugins: readonly PluginManifestRecord[],
  enabledPluginIds?: ReadonlySet<string>,
) {
  const providerEndpoints = [...plugins, ...listOfficialExternalProviderEndpointManifests()]
    .flatMap((plugin) => prepareProviderEndpoints(plugin.providerEndpoints))
    .filter((endpoint) => PROVIDER_ENDPOINT_CLASSES.has(endpoint.endpointClass));
  const providerRequests = new Map(
    [...collectPluginProviderRequestOwners(plugins)].map(([provider, { policy }]) => [
      provider,
      policy,
    ]),
  );
  const providerAuthContributions: PluginProviderAuthContribution[] = [];
  const providersManagingOwnAvailability = new Set<string>();
  const selectedProviders = new Set<string>();
  for (const plugin of plugins) {
    if (enabledPluginIds?.has(plugin.id)) {
      for (const rawProvider of plugin.providers) {
        const provider = normalizeProviderId(rawProvider);
        if (!provider || selectedProviders.has(provider)) {
          continue;
        }
        selectedProviders.add(provider);
        if (plugin.managesOwnAvailability === true) {
          providersManagingOwnAvailability.add(provider);
        }
      }
    }
    // Package declarations are stable; readers still decide eligibility against current config.
    const envProviders = (plugin.setup?.providers ?? []).filter(
      (provider) => provider.envVars?.length,
    );
    const evidenceProviders = (plugin.setup?.providers ?? []).filter(
      (provider) => provider.authEvidence?.length,
    );
    const fallbackProviderRefs =
      plugin.setup?.requiresRuntime !== false
        ? listSetupProviderIds(plugin).map(normalizeProviderId).filter(Boolean)
        : [];
    if (envProviders.length || evidenceProviders.length || fallbackProviderRefs.length) {
      providerAuthContributions.push({
        plugin,
        envProviders,
        evidenceProviders,
        fallbackProviderRefs,
      });
    }
  }
  return {
    providerEndpoints,
    providerRequests,
    providerAuthContributions,
    providersManagingOwnAvailability,
    modelIdNormalizationPolicies: collectManifestModelIdNormalizationPolicies(plugins),
    providerAuthAliases: buildPluginMetadataProviderAuthAliases(plugins),
  };
}
