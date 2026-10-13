import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareBundledCapabilityRuntime } from "../plugins/bundled-capability-runtime.js";
import {
  preparePluginCapabilityProviderLookup,
  preparePluginCapabilityProviderResolution,
} from "../plugins/capability-provider-runtime.js";
import { createLegacyPluginSdkProviderProjection } from "../plugins/legacy-sdk-provider-projection.js";
import { loadOpenClawPluginsWithInternalOverrides } from "../plugins/loader-runtime-load.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import { loadLegacyPluginMetadataSnapshotRuntime } from "../plugins/plugin-metadata-snapshot-required.js";
import {
  buildCapabilityProviderIndex,
  normalizeCapabilityProviderId,
} from "../plugins/provider-registry-shared.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import {
  resolveConfiguredRealtimeVoiceProvider as resolvePreparedRealtimeVoiceProvider,
  type ResolveConfiguredRealtimeVoiceProviderParams,
  type ResolvedRealtimeVoiceProvider,
} from "./provider-resolver.js";
import type { RealtimeVoiceProviderId } from "./provider-types.js";

type VoiceResolution = ReturnType<
  typeof preparePluginCapabilityProviderResolution<"realtimeVoiceProviders">
>;
type VoiceLoad = ReturnType<
  Extract<VoiceResolution, { prepareLoad: () => unknown }>["prepareLoad"]
>;

function warnLegacy(method: string, replacement: string) {
  warnPluginSdkDeprecation({
    family: "realtime-voice-registry-sync",
    method,
    replacement,
    compatibility: "The synchronous SDK helpers retain cold native provider discovery.",
  });
}

// Released SDK readers retain native loading; internal registry consumers stay prepared-only.
function loadLegacyVoiceEntries(load: VoiceLoad): PluginRegistry["realtimeVoiceProviders"] {
  if (load.loadOptions.onlyPluginIds?.length === 0) {
    return [];
  }
  const registry = load.loadedRegistry ?? loadPluginRegistryHandle(load.resolveLoadOptions());
  const { entries, pluginIds } = load.fallback(registry);
  if (pluginIds.length === 0) {
    return entries;
  }
  const prepared = prepareBundledCapabilityRuntime({ ...load.loadOptions, pluginIds });
  return load.merge(
    entries,
    loadOpenClawPluginsWithInternalOverrides(prepared.options, prepared.overrides),
  );
}

/** @deprecated Await listRealtimeVoiceProvidersAsync; removed in a later release after stable deprecation. */
export function listRealtimeVoiceProvidersLegacy(
  cfg?: OpenClawConfig,
  additionalProviderIds?: readonly string[],
): RealtimeVoiceProviderPlugin[] {
  warnLegacy("listRealtimeVoiceProviders", "listRealtimeVoiceProvidersAsync");
  const snapshot = loadLegacyPluginMetadataSnapshotRuntime({
    config: cfg,
    allowWorkspaceScopedCurrent: true,
  });
  using projection = createLegacyPluginSdkProviderProjection();
  const resolution = preparePluginCapabilityProviderResolution<"realtimeVoiceProviders">(
    { key: "realtimeVoiceProviders", cfg, additionalProviderIds },
    (registry) => projection.select(registry),
    snapshot,
  );
  const providers = resolution.resolve(
    resolution.load ? loadLegacyVoiceEntries(resolution.prepareLoad()) : [],
  );
  projection.adopt();
  return [...buildCapabilityProviderIndex(providers, "canonical").values()];
}

/** @deprecated Await getRealtimeVoiceProviderAsync; removed in a later release after stable deprecation. */
export function getRealtimeVoiceProviderLegacy(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): RealtimeVoiceProviderPlugin | undefined {
  warnLegacy("getRealtimeVoiceProvider", "getRealtimeVoiceProviderAsync");
  const normalized = normalizeCapabilityProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  const snapshot = loadLegacyPluginMetadataSnapshotRuntime({
    config: cfg,
    allowWorkspaceScopedCurrent: true,
  });
  using projection = createLegacyPluginSdkProviderProjection();
  const resolution = preparePluginCapabilityProviderLookup<"realtimeVoiceProviders">(
    { key: "realtimeVoiceProviders", providerId: normalized, cfg },
    (registry) => projection.select(registry),
    snapshot,
  );
  const provider = resolution.resolve(
    resolution.load ? loadLegacyVoiceEntries(resolution.prepareLoad()) : [],
  );
  projection.adopt();
  return provider;
}

/** @deprecated Await canonicalizeRealtimeVoiceProviderIdAsync; removed in a later release after stable deprecation. */
export function canonicalizeRealtimeVoiceProviderIdLegacy(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): RealtimeVoiceProviderId | undefined {
  warnLegacy("canonicalizeRealtimeVoiceProviderId", "canonicalizeRealtimeVoiceProviderIdAsync");
  const normalized = normalizeCapabilityProviderId(providerId);
  return normalized
    ? (getRealtimeVoiceProviderLegacy(normalized, cfg)?.id ?? normalized)
    : undefined;
}

/** @deprecated Await resolveConfiguredRealtimeVoiceProviderAsync; removed in a later release after stable deprecation. */
export function resolveConfiguredRealtimeVoiceProviderLegacy(
  params: ResolveConfiguredRealtimeVoiceProviderParams,
): ResolvedRealtimeVoiceProvider {
  warnLegacy(
    "resolveConfiguredRealtimeVoiceProvider",
    "resolveConfiguredRealtimeVoiceProviderAsync",
  );
  const configuredId = params.configuredProviderId?.trim();
  const provider =
    !params.providers && configuredId
      ? getRealtimeVoiceProviderLegacy(configuredId, params.cfg)
      : undefined;
  const providers =
    params.providers ??
    (configuredId
      ? provider
        ? [provider]
        : []
      : listRealtimeVoiceProvidersLegacy(params.cfg, Object.keys(params.providerConfigs ?? {})));
  return resolvePreparedRealtimeVoiceProvider({ ...params, providers });
}
