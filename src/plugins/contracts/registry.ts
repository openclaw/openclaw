// Plugin contract registry assembles bundled plugin fixtures for shared contract tests.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { loadBundledCapabilityRuntimeRegistry } from "../bundled-capability-runtime.js";
import { discoverOpenClawPlugins } from "../discovery.js";
import { loadPluginManifestRegistryCore } from "../manifest-registry.js";
import { resolveBundledExplicitProviderContractsFromPublicArtifacts } from "../provider-contract-public-artifacts.js";
import type { ProviderPlugin, WebFetchProviderPlugin, WebSearchProviderPlugin } from "../types.js";
import { resolveBundledExplicitWebSearchProvidersFromPublicArtifacts } from "../web-provider-public-artifacts.explicit.js";
import {
  BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS,
  buildBundledPluginContractSnapshot,
  type BundledPluginContractSnapshot,
} from "./inventory/bundled-capability-metadata.js";
import { normalizeContractStringValues } from "./shared.js";

type BundledCapabilityRuntimeRegistry = ReturnType<typeof loadBundledCapabilityRuntimeRegistry>;
type CapabilityContractEntry<T> = {
  pluginId: string;
  provider: T;
};

type ProviderContractEntry = CapabilityContractEntry<ProviderPlugin>;
type WebSearchProviderContractEntry = CapabilityContractEntry<WebSearchProviderPlugin> & {
  credentialValue: unknown;
};
type WebFetchProviderContractEntry = CapabilityContractEntry<WebFetchProviderPlugin> & {
  credentialValue: unknown;
};

type PluginRegistrationContractEntry = BundledPluginContractSnapshot;

function normalizeProviderEnvVars(
  providerEnvVars: Record<string, string[]> | undefined,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(providerEnvVars ?? {}).map(([providerId, envVars]) => [
      providerId,
      normalizeContractStringValues(envVars),
    ]),
  );
}

function resolvePluginProviderEnvVars(plugin: {
  setup?: { providers?: Array<{ id: string; envVars?: string[] }> };
}): Record<string, string[]> {
  const envVars: Record<string, string[]> = {};
  for (const provider of plugin.setup?.providers ?? []) {
    envVars[provider.id] = provider.envVars ?? [];
  }
  return normalizeProviderEnvVars(envVars);
}

export function getPluginRegistrationContracts(): PluginRegistrationContractEntry[] {
  if (process.env.VITEST) {
    return BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.map((entry) => structuredClone(entry));
  }
  return loadPluginManifestRegistryCore({})
    .plugins.filter(
      (plugin) =>
        plugin.origin === "bundled" &&
        (plugin.cliBackends.length > 0 ||
          plugin.providers.length > 0 ||
          (plugin.contracts?.workerProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.storageProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.embeddingProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.speechProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.realtimeTranscriptionProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.realtimeVoiceProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.mediaUnderstandingProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.transcriptSourceProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.documentExtractors?.length ?? 0) > 0 ||
          (plugin.contracts?.imageGenerationProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.videoGenerationProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.musicGenerationProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.webContentExtractors?.length ?? 0) > 0 ||
          (plugin.contracts?.webFetchProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.webSearchProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.migrationProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.tools?.length ?? 0) > 0),
    )
    .map((plugin) =>
      buildBundledPluginContractSnapshot(
        plugin,
        normalizeContractStringValues,
        resolvePluginProviderEnvVars(plugin),
      ),
    );
}

function formatBundledCapabilityPluginLoadError(params: {
  pluginId: string;
  capabilityLabel: string;
  registry: BundledCapabilityRuntimeRegistry;
}): Error {
  const plugin = params.registry.plugins.find((entry) => entry.id === params.pluginId);
  const diagnostics = params.registry.diagnostics
    .filter((entry) => entry.pluginId === params.pluginId)
    .map((entry) => entry.message);
  const providerIds = params.registry.providers
    .filter((entry) => entry.pluginId === params.pluginId)
    .map((entry) => entry.provider.id);
  const webFetchProviderIds = params.registry.webFetchProviders
    .filter((entry) => entry.pluginId === params.pluginId)
    .map((entry) => entry.provider.id);
  const webSearchProviderIds = params.registry.webSearchProviders
    .filter((entry) => entry.pluginId === params.pluginId)
    .map((entry) => entry.provider.id);
  const detailParts = plugin
    ? [
        `status=${plugin.status}`,
        ...(plugin.error ? [`error=${plugin.error}`] : []),
        `providerIds=[${providerIds.join(", ")}]`,
        `webFetchProviderIds=[${webFetchProviderIds.join(", ")}]`,
        `webSearchProviderIds=[${webSearchProviderIds.join(", ")}]`,
      ]
    : ["plugin record missing"];
  if (diagnostics.length > 0) {
    detailParts.push(`diagnostics=${diagnostics.join(" | ")}`);
  }
  return new Error(
    `bundled ${params.capabilityLabel} contract load failed for ${params.pluginId}: ${detailParts.join("; ")}`,
  );
}

function loadScopedCapabilityRuntimeRegistryEntries<T>(params: {
  pluginId: string;
  capabilityLabel: string;
  loadEntries: (registry: BundledCapabilityRuntimeRegistry) => T[];
}): T[] {
  const discovery = discoverOpenClawPlugins({});
  const registry = loadBundledCapabilityRuntimeRegistry({
    pluginIds: [params.pluginId],
    pluginSdkResolution: "dist",
    discovery,
  });
  const entries = params.loadEntries(registry);
  if (entries.length > 0) {
    return entries;
  }
  throw formatBundledCapabilityPluginLoadError({
    pluginId: params.pluginId,
    capabilityLabel: params.capabilityLabel,
    registry,
  });
}

export function resolveProviderContractEntriesForPluginId(
  pluginId: string,
): ProviderContractEntry[] {
  const publicArtifactEntries = resolveBundledExplicitProviderContractsFromPublicArtifacts({
    onlyPluginIds: [pluginId],
  });
  if (publicArtifactEntries) {
    return publicArtifactEntries;
  }

  return loadScopedCapabilityRuntimeRegistryEntries({
    pluginId,
    capabilityLabel: "provider",
    loadEntries: (registry) =>
      registry.providers
        .filter((entry) => entry.pluginId === pluginId)
        .map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
        })),
  });
}

function resolveWebSearchCredentialValue(provider: WebSearchProviderPlugin): unknown {
  if (provider.requiresCredential === false) {
    return `${provider.id}-no-key-needed`;
  }
  const envVar = provider.envVars.find((entry) => entry.trim().length > 0);
  if (!envVar) {
    return `${provider.id}-test`;
  }
  if (envVar === "OPENROUTER_API_KEY") {
    return "openrouter-test";
  }
  return normalizeLowercaseStringOrEmpty(envVar).includes("api_key")
    ? `${provider.id}-test`
    : "sk-test";
}

function resolveWebFetchCredentialValue(provider: WebFetchProviderPlugin): unknown {
  if (provider.requiresCredential === false) {
    return `${provider.id}-no-key-needed`;
  }
  const envVar = provider.envVars.find((entry) => entry.trim().length > 0);
  if (!envVar) {
    return `${provider.id}-test`;
  }
  return normalizeLowercaseStringOrEmpty(envVar).includes("api_key")
    ? `${provider.id}-test`
    : "sk-test";
}

export function resolveWebFetchProviderContractEntriesForPluginId(
  pluginId: string,
): WebFetchProviderContractEntry[] {
  return loadScopedCapabilityRuntimeRegistryEntries({
    pluginId,
    capabilityLabel: "web fetch provider",
    loadEntries: (registry) =>
      registry.webFetchProviders
        .filter((entry) => entry.pluginId === pluginId)
        .map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
          credentialValue: resolveWebFetchCredentialValue(entry.provider),
        })),
  });
}

export function resolveWebSearchProviderContractEntriesForPluginId(
  pluginId: string,
): WebSearchProviderContractEntry[] {
  const publicArtifactEntries = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
    onlyPluginIds: [pluginId],
  })?.map((provider) => ({
    pluginId: provider.pluginId,
    provider,
    credentialValue: resolveWebSearchCredentialValue(provider),
  }));
  if (publicArtifactEntries) {
    return publicArtifactEntries;
  }

  return loadScopedCapabilityRuntimeRegistryEntries({
    pluginId,
    capabilityLabel: "web search provider",
    loadEntries: (registry) =>
      registry.webSearchProviders
        .filter((entry) => entry.pluginId === pluginId)
        .map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
          credentialValue: resolveWebSearchCredentialValue(entry.provider),
        })),
  });
}

export function resolveProviderContractProvidersForPluginIds(
  pluginIds: readonly string[],
): ProviderPlugin[] {
  const allowed = new Set(pluginIds);
  return [
    ...new Map(
      [...allowed]
        .flatMap(resolveProviderContractEntriesForPluginId)
        .filter((entry) => allowed.has(entry.pluginId))
        .map((entry) => [entry.provider.id, entry.provider]),
    ).values(),
  ];
}
