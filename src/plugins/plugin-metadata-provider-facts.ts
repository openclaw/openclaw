import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { collectManifestModelIdNormalizationPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import officialExternalProviderCatalog from "../../scripts/lib/official-external-provider-catalog.json" with { type: "json" };
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { normalizeManifestProviderEndpoints } from "./manifest-capability-normalizers.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginManifestProviderEndpoint } from "./manifest.js";
import type {
  PluginProviderAuthAliasCandidate,
  PluginProviderAuthContribution,
} from "./plugin-metadata-snapshot.types.js";
import { collectPluginProviderRequestOwners } from "./plugin-provider-request-policy.js";
import { PLUGIN_ORIGIN_PRIORITIES } from "./record-groups.js";
import { listSetupProviderIds } from "./setup-descriptors.js";

const PROVIDER_ENDPOINT_CLASSES = new Set(
  "anthropic-public cerebras-native chutes-native deepseek-native github-copilot-native groq-native meta-native mistral-public minimax-native moonshot-native modelstudio-native novita-native nvidia-native openai-public openai opencode-native opencode-go-native azure-openai openrouter vercel-ai-gateway xai-native xiaomi-native zai-native google-generative-ai google-vertex".split(
    " ",
  ),
);

export function isPluginProviderEndpointClass(endpointClass: string): boolean {
  return PROVIDER_ENDPOINT_CLASSES.has(endpointClass);
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

export function prepareProviderEndpoints(
  value: readonly PluginManifestProviderEndpoint[] | undefined,
): PluginManifestProviderEndpoint[] {
  const endpoints: PluginManifestProviderEndpoint[] = [];
  for (const endpoint of value ?? []) {
    endpoints.push({
      endpointClass: endpoint.endpointClass,
      hosts: endpoint.hosts ?? [],
      hostSuffixes: endpoint.hostSuffixes ?? [],
      baseUrls: (endpoint.baseUrls ?? [])
        .map((baseUrl) => normalizePluginProviderBaseUrl(baseUrl.toLowerCase()))
        .filter((baseUrl): baseUrl is string => baseUrl !== undefined),
      ...(endpoint.googleVertexRegion ? { googleVertexRegion: endpoint.googleVertexRegion } : {}),
      ...(endpoint.googleVertexRegionHostSuffix
        ? { googleVertexRegionHostSuffix: endpoint.googleVertexRegionHostSuffix }
        : {}),
    });
  }
  return endpoints;
}

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
        (PLUGIN_ORIGIN_PRIORITIES[left.plugin.origin]?.provider ?? Number.MAX_SAFE_INTEGER) -
        (PLUGIN_ORIGIN_PRIORITIES[right.plugin.origin]?.provider ?? Number.MAX_SAFE_INTEGER),
    );
  }
  return aliases;
}

export function buildPluginMetadataProviderFacts(
  plugins: readonly PluginManifestRecord[],
  enabledPluginIds?: ReadonlySet<string>,
) {
  /**
   * Provider endpoint metadata for officially externalized provider plugins.
   *
   * Endpoint classification (SSRF, attribution, payload-compat policy) keys off
   * base URLs and must keep working when the owning plugin is not installed:
   * dist packages exclude externalized plugins, so their manifests are invisible
   * to bundled discovery. Only the repo-bundled catalog JSON feeds this table;
   * hosted marketplace feeds must never influence endpoint classification.
   * Keep this JSON separate from official-external-plugin-catalog.ts so provider
   * transports do not pull the ClawHub install/marketplace module graph.
   */
  /**
   * Lists manifest-shaped catalog metadata blocks that declare provider endpoints.
   *
   * The catalog mirrors manifests faithfully, including endpoint classes core
   * does not (yet) recognize (e.g. deepinfra-native, gmi-native). The endpoint
   * reader filters unknown classes exactly as it does for installed manifests,
   * so they stay inert instead of complicating the mirror contract.
   */
  const providerEndpoints = [
    ...plugins,
    ...officialExternalProviderCatalog.entries.flatMap((entry) => {
      const manifest = entry[MANIFEST_KEY];
      const catalogEndpoints = normalizeManifestProviderEndpoints(manifest.providerEndpoints);
      return catalogEndpoints ? [{ ...manifest, providerEndpoints: catalogEndpoints }] : [];
    }),
  ]
    .flatMap((plugin) => prepareProviderEndpoints(plugin.providerEndpoints))
    .filter((endpoint) => isPluginProviderEndpointClass(endpoint.endpointClass));
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
