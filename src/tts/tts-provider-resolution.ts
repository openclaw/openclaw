import { clampTimerTimeoutMs } from "../../packages/normalization-core/src/number-coercion.js";
import { asNonArrayRecord } from "../../packages/normalization-core/src/record-coerce.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../packages/normalization-core/src/string-coerce.js";
import type { OpenClawConfig, ResolvedTtsPersona, TtsProvider } from "../config/types.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { compareSpeechProviderOrder } from "./provider-registry-core.js";
import {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listSpeechProviders,
  normalizeSpeechProviderId,
} from "./provider-registry.js";
import type { SpeechProviderConfig } from "./provider-types.js";
import { withSpeakerSelectionCompat } from "./speaker.js";
import {
  DEFAULT_TTS_TIMEOUT_MS,
  asProviderConfig,
  normalizeConfiguredSpeechProviderId,
  readTtsPrefs as readPrefs,
  resolveTtsPersonaFromPrefs,
  resolveTtsRuntimeConfig,
  type ResolvedTtsConfig,
  type TtsProviderPreference,
} from "./tts-settings.js";
import {
  resolvePrimaryVoiceProviderCandidate,
  resolveSupportedVoiceModelRefs,
  resolveVoiceModelRefs,
  resolveVoiceProviderCandidates,
  voiceProviderSupportsModel,
  type VoiceModelProvider,
  type VoiceModelRef,
  type VoiceProviderCandidate,
} from "./voice-models.js";

export type TtsProviderRegistry = {
  runtimeConfig?: OpenClawConfig;
  canonicalizeSpeechProviderId: typeof canonicalizeSpeechProviderId;
  getSpeechProvider: typeof getSpeechProvider;
  listSpeechProviders: typeof listSpeechProviders;
};

const defaultProviderRegistry: TtsProviderRegistry = {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listSpeechProviders,
};

function resolveProviderRuntimeConfig(
  cfg: OpenClawConfig,
  registry: TtsProviderRegistry,
): OpenClawConfig {
  return registry.runtimeConfig ?? resolveTtsRuntimeConfig(cfg);
}

function resolvePositiveTimeoutMs(timeoutMs: number | undefined): number | undefined {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? clampTimerTimeoutMs(timeoutMs)
    : undefined;
}

export function resolveSpeechProviderTimeoutMs(params: {
  timeoutMs?: number;
  config: ResolvedTtsConfig;
  provider: Pick<SpeechProviderPlugin, "defaultTimeoutMs">;
}): number {
  if (params.timeoutMs !== undefined) {
    return resolvePositiveTimeoutMs(params.timeoutMs) ?? params.config.timeoutMs;
  }
  if (params.config.timeoutMsSource !== "default") {
    return resolvePositiveTimeoutMs(params.config.timeoutMs) ?? DEFAULT_TTS_TIMEOUT_MS;
  }
  return resolvePositiveTimeoutMs(params.provider.defaultTimeoutMs) ?? params.config.timeoutMs;
}

function sortSpeechProvidersForAutoSelection(
  cfg?: OpenClawConfig,
  providers?: readonly SpeechProviderPlugin[],
  registry: TtsProviderRegistry = defaultProviderRegistry,
) {
  return (providers ?? registry.listSpeechProviders(cfg)).toSorted(compareSpeechProviderOrder);
}

function canonicalizeSpeechProviderIdFromInventory(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
  providers?: readonly SpeechProviderPlugin[],
): string | undefined {
  const normalized = normalizeSpeechProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  if (!providers) {
    return canonicalizeSpeechProviderId(providerId, cfg);
  }
  const inventoryProvider = findInventoryProvider(providers, normalized);
  // A prepared inventory can omit voice-model-only providers. Preserve the
  // registry's public alias contract on misses instead of exposing an alias.
  return inventoryProvider?.id ?? canonicalizeSpeechProviderId(providerId, cfg) ?? normalized;
}

function findInventoryProvider(providers: readonly SpeechProviderPlugin[], providerId: string) {
  const normalized = normalizeSpeechProviderId(providerId);
  return providers.find(
    (provider) =>
      normalizeSpeechProviderId(provider.id) === normalized ||
      provider.aliases?.some((alias) => normalizeSpeechProviderId(alias) === normalized),
  );
}

function resolveConfiguredSpeechVoiceModelRefs(
  cfg: OpenClawConfig | undefined,
  providers?: readonly SpeechProviderPlugin[],
  registry: TtsProviderRegistry = defaultProviderRegistry,
): VoiceModelRef[] {
  const effectiveCfg = cfg ? resolveProviderRuntimeConfig(cfg, registry) : undefined;
  return resolveSupportedVoiceModelRefs({
    config: effectiveCfg?.agents?.defaults?.voiceModel,
    providers: sortSpeechProvidersForAutoSelection(effectiveCfg, providers, registry),
  });
}

function applyVoiceModelToSpeechProviderConfig(params: {
  cfg: OpenClawConfig | undefined;
  providerId: string;
  providerConfig: SpeechProviderConfig;
  provider?: VoiceModelProvider;
  voiceModel?: VoiceModelRef;
  registry?: TtsProviderRegistry;
}): SpeechProviderConfig {
  const registry = params.registry ?? defaultProviderRegistry;
  const provider = params.provider ?? registry.getSpeechProvider(params.providerId, params.cfg);
  const voiceModel = params.voiceModel
    ? voiceProviderSupportsModel(provider, params.voiceModel.model)
      ? params.voiceModel
      : undefined
    : resolveSupportedVoiceModelRefs({
        config: params.cfg?.agents?.defaults?.voiceModel,
        providers: provider ? [provider] : [],
        providerId: params.providerId,
      })[0];
  if (!voiceModel) {
    return params.providerConfig;
  }
  const hasExplicitModel =
    normalizeOptionalString(params.providerConfig.model) ||
    normalizeOptionalString(params.providerConfig.modelId);
  if (hasExplicitModel) {
    return params.providerConfig;
  }
  return {
    ...params.providerConfig,
    model: voiceModel.model,
    modelId: voiceModel.model,
  };
}

export function resolvePersonaProviderConfig(
  persona: ResolvedTtsPersona | undefined,
  providerId: string,
): SpeechProviderConfig | undefined {
  if (!persona?.providers) {
    return undefined;
  }
  const normalized = normalizeConfiguredSpeechProviderId(providerId) ?? providerId;
  if (Object.hasOwn(persona.providers, normalized)) {
    return persona.providers[normalized];
  }
  if (Object.hasOwn(persona.providers, providerId)) {
    return persona.providers[providerId];
  }
  return undefined;
}

export function mergeProviderConfigWithPersona(params: {
  providerConfig: SpeechProviderConfig;
  persona?: ResolvedTtsPersona;
  providerId: string;
}): {
  providerConfig: SpeechProviderConfig;
  personaProviderConfig?: SpeechProviderConfig;
  personaBinding: "applied" | "missing" | "none";
} {
  if (!params.persona) {
    return { providerConfig: params.providerConfig, personaBinding: "none" };
  }
  const personaProviderConfig = resolvePersonaProviderConfig(params.persona, params.providerId);
  if (!personaProviderConfig) {
    return { providerConfig: params.providerConfig, personaBinding: "missing" };
  }
  return {
    providerConfig: {
      ...params.providerConfig,
      ...personaProviderConfig,
    },
    personaProviderConfig,
    personaBinding: "applied",
  };
}

function resolveLazyProviderConfig(
  config: ResolvedTtsConfig,
  providerId: string,
  cfg?: OpenClawConfig,
  voiceModel?: VoiceModelRef,
  provider?: SpeechProviderPlugin,
  registry: TtsProviderRegistry = defaultProviderRegistry,
): SpeechProviderConfig {
  const canonical =
    normalizeConfiguredSpeechProviderId(providerId) ?? normalizeLowercaseStringOrEmpty(providerId);
  const existing = voiceModel ? undefined : config.providerConfigs[canonical];
  const effectiveCfg = cfg ? resolveProviderRuntimeConfig(cfg, registry) : config.sourceConfig;
  if (existing && !effectiveCfg) {
    return existing;
  }
  const rawBaseConfig = config.rawConfig as Record<string, unknown> | undefined;
  const rawProviders = asNonArrayRecord(config.rawConfig?.providers);
  const rawConfig = asProviderConfig(rawProviders[canonical] ?? rawBaseConfig?.[canonical]);
  const resolvedProvider = provider ?? registry.getSpeechProvider(canonical, effectiveCfg);
  let hasRawProviderConfig =
    Object.hasOwn(rawProviders, canonical) ||
    (rawBaseConfig ? Object.hasOwn(rawBaseConfig, canonical) : false);
  let rawProviderConfig = rawProviders[canonical] ?? rawBaseConfig?.[canonical];
  if (!hasRawProviderConfig) {
    for (const alias of resolvedProvider?.aliases ?? []) {
      const normalizedAlias = normalizeSpeechProviderId(alias);
      if (!normalizedAlias) {
        continue;
      }
      if (Object.hasOwn(rawProviders, normalizedAlias)) {
        hasRawProviderConfig = true;
        rawProviderConfig = rawProviders[normalizedAlias];
        break;
      }
      if (rawBaseConfig && Object.hasOwn(rawBaseConfig, normalizedAlias)) {
        hasRawProviderConfig = true;
        rawProviderConfig = rawBaseConfig[normalizedAlias];
        break;
      }
    }
  }
  const compatRawProviderConfig = applyVoiceModelToSpeechProviderConfig({
    cfg: effectiveCfg,
    providerId: canonical,
    providerConfig: asProviderConfig(rawProviderConfig),
    provider: resolvedProvider,
    voiceModel,
    registry,
  });
  const shouldInjectCanonicalProviderConfig =
    hasRawProviderConfig || Boolean(voiceModel) || Object.keys(rawProviders).length === 0;
  const rawConfigForProvider = {
    ...rawBaseConfig,
    providers: shouldInjectCanonicalProviderConfig
      ? {
          ...rawProviders,
          [canonical]: compatRawProviderConfig,
        }
      : rawProviders,
    ...(shouldInjectCanonicalProviderConfig ? { [canonical]: compatRawProviderConfig } : {}),
  };
  const next =
    effectiveCfg && resolvedProvider?.resolveConfig
      ? withSpeakerSelectionCompat(
          resolvedProvider.resolveConfig({
            cfg: effectiveCfg,
            rawConfig: rawConfigForProvider,
            timeoutMs: resolveSpeechProviderTimeoutMs({ config, provider: resolvedProvider }),
          }),
        )
      : applyVoiceModelToSpeechProviderConfig({
          cfg: effectiveCfg,
          providerId: canonical,
          providerConfig: rawConfig,
          provider: resolvedProvider,
          voiceModel,
          registry,
        });
  if (!voiceModel) {
    config.providerConfigs[canonical] = next;
  }
  return next;
}

export function getResolvedSpeechProviderConfig(
  config: ResolvedTtsConfig,
  providerId: string,
  cfg?: OpenClawConfig,
): SpeechProviderConfig {
  return resolveSpeechProviderConfig(config, providerId, cfg, defaultProviderRegistry);
}

function resolveSpeechProviderConfig(
  config: ResolvedTtsConfig,
  providerId: string,
  cfg: OpenClawConfig | undefined,
  registry: TtsProviderRegistry,
  voiceModel?: VoiceModelRef,
): SpeechProviderConfig {
  const effectiveCfg = cfg ? resolveProviderRuntimeConfig(cfg, registry) : config.sourceConfig;
  const canonical =
    registry.canonicalizeSpeechProviderId(providerId, effectiveCfg) ??
    normalizeConfiguredSpeechProviderId(providerId) ??
    normalizeLowercaseStringOrEmpty(providerId);
  return resolveLazyProviderConfig(
    config,
    canonical,
    effectiveCfg,
    voiceModel,
    undefined,
    registry,
  );
}

export function getResolvedSpeechProviderConfigForVoiceModel(params: {
  config: ResolvedTtsConfig;
  providerId: string;
  cfg: OpenClawConfig;
  voiceModel?: VoiceModelRef;
  registry?: TtsProviderRegistry;
}): SpeechProviderConfig {
  return resolveSpeechProviderConfig(
    params.config,
    params.providerId,
    params.cfg,
    params.registry ?? defaultProviderRegistry,
    params.voiceModel,
  );
}

function resolvePreferredTtsProvider(
  config: ResolvedTtsConfig,
  prefsPath: string,
  registry: TtsProviderRegistry = defaultProviderRegistry,
  prefs = readPrefs(prefsPath),
): TtsProvider | undefined {
  const prefsProvider =
    registry.canonicalizeSpeechProviderId(prefs.tts?.provider) ??
    normalizeConfiguredSpeechProviderId(prefs.tts?.provider);
  if (prefsProvider) {
    return prefsProvider;
  }
  const activePersona = resolveTtsPersonaFromPrefs(config, prefs);
  const personaProvider =
    registry.canonicalizeSpeechProviderId(activePersona?.provider, config.sourceConfig) ??
    normalizeConfiguredSpeechProviderId(activePersona?.provider);
  if (personaProvider && registry.getSpeechProvider(personaProvider, config.sourceConfig)) {
    return personaProvider;
  }
  if (config.providerSource === "config") {
    return normalizeConfiguredSpeechProviderId(config.provider) ?? config.provider;
  }
  const configuredVoiceProvider = resolveConfiguredSpeechVoiceModelRefs(
    config.sourceConfig,
    undefined,
    registry,
  )[0]?.provider;
  if (
    configuredVoiceProvider &&
    registry.getSpeechProvider(configuredVoiceProvider, config.sourceConfig)
  ) {
    return configuredVoiceProvider;
  }

  return undefined;
}

export function resolveTtsProvider(
  config: ResolvedTtsConfig,
  prefsPath: string,
  registry: TtsProviderRegistry = defaultProviderRegistry,
  prefs = readPrefs(prefsPath),
): TtsProvider {
  const preferred = resolvePreferredTtsProvider(config, prefsPath, registry, prefs);
  if (preferred) {
    return preferred;
  }
  const effectiveCfg = config.sourceConfig;
  for (const provider of sortSpeechProvidersForAutoSelection(effectiveCfg, undefined, registry)) {
    if (isSpeechProviderConfigured(config, provider.id, effectiveCfg, registry)) {
      return provider.id;
    }
  }
  return config.provider;
}

export async function resolveTtsProviderAsync(
  config: ResolvedTtsConfig,
  prefsPath: string,
  registry: TtsProviderRegistry = defaultProviderRegistry,
  prefs = readPrefs(prefsPath),
): Promise<TtsProvider> {
  const preferred = resolvePreferredTtsProvider(config, prefsPath, registry, prefs);
  if (preferred) {
    return preferred;
  }
  const effectiveCfg = config.sourceConfig;
  for (const provider of sortSpeechProvidersForAutoSelection(effectiveCfg, undefined, registry)) {
    if (await isSpeechProviderConfiguredAsync(config, provider, effectiveCfg, registry)) {
      return provider.id;
    }
  }
  return config.provider;
}

export function resolvePreparedTtsProvider(params: {
  config: ResolvedTtsConfig;
  preference?: TtsProviderPreference;
  providers: readonly SpeechProviderPlugin[];
  configuredByProvider: ReadonlyMap<string, boolean>;
}): TtsProvider {
  const effectiveCfg = params.config.sourceConfig;
  if (params.preference?.source === "prefs") {
    return (
      canonicalizeSpeechProviderIdFromInventory(
        params.preference.provider,
        effectiveCfg,
        params.providers,
      ) ?? params.preference.provider
    );
  }
  if (params.preference?.source === "persona") {
    const preferredProvider = params.preference.provider;
    const inventoryProvider = findInventoryProvider(params.providers, preferredProvider);
    const personaProvider = inventoryProvider ?? getSpeechProvider(preferredProvider, effectiveCfg);
    if (personaProvider) {
      return personaProvider.id;
    }
  }
  if (params.preference?.source === "config") {
    return (
      normalizeConfiguredSpeechProviderId(params.preference.provider) ?? params.preference.provider
    );
  }
  const configuredVoiceProvider = resolveConfiguredSpeechVoiceModelRefs(
    effectiveCfg,
    params.providers,
  )[0]?.provider;
  if (configuredVoiceProvider) {
    return configuredVoiceProvider;
  }
  for (const provider of sortSpeechProvidersForAutoSelection(effectiveCfg, params.providers)) {
    if (params.configuredByProvider.get(provider.id) === true) {
      return provider.id;
    }
  }
  return params.config.provider;
}

export function resolveTtsProviderOrder(
  primary: TtsProvider,
  cfg?: OpenClawConfig,
  providers?: readonly SpeechProviderPlugin[],
): TtsProvider[] {
  const effectiveCfg = cfg ? resolveTtsRuntimeConfig(cfg) : undefined;
  const normalizedPrimary =
    canonicalizeSpeechProviderIdFromInventory(primary, effectiveCfg, providers) ?? primary;
  const ordered = new Set<TtsProvider>([normalizedPrimary]);
  for (const ref of resolveVoiceModelRefs(effectiveCfg?.agents?.defaults?.voiceModel)) {
    const provider =
      canonicalizeSpeechProviderIdFromInventory(ref.provider, effectiveCfg, providers) ??
      ref.provider;
    ordered.add(provider);
  }
  for (const provider of sortSpeechProvidersForAutoSelection(effectiveCfg, providers)) {
    ordered.add(provider.id);
  }
  return [...ordered];
}

export function resolveTtsProviderCandidates(
  primary: TtsProvider,
  cfg?: OpenClawConfig,
  registry: TtsProviderRegistry = defaultProviderRegistry,
): VoiceProviderCandidate[] {
  const effectiveCfg = cfg ? resolveProviderRuntimeConfig(cfg, registry) : undefined;
  const normalizedPrimary = registry.canonicalizeSpeechProviderId(primary, effectiveCfg) ?? primary;
  return resolveVoiceProviderCandidates({
    primaryProvider: normalizedPrimary,
    providers: sortSpeechProvidersForAutoSelection(effectiveCfg, undefined, registry),
    voiceModelConfig: effectiveCfg?.agents?.defaults?.voiceModel,
  });
}

export function resolvePrimaryTtsProviderCandidate(
  primary: TtsProvider,
  cfg?: OpenClawConfig,
  registry: TtsProviderRegistry = defaultProviderRegistry,
): VoiceProviderCandidate {
  const effectiveCfg = cfg ? resolveProviderRuntimeConfig(cfg, registry) : undefined;
  return resolvePrimaryVoiceProviderCandidate({
    primaryProvider: registry.canonicalizeSpeechProviderId(primary, effectiveCfg) ?? primary,
    providers: sortSpeechProvidersForAutoSelection(effectiveCfg, undefined, registry),
    voiceModelConfig: effectiveCfg?.agents?.defaults?.voiceModel,
  });
}

/** @deprecated Use isTtsProviderConfiguredAsync. Removed at the next Plugin SDK major. */
export function isTtsProviderConfigured(
  config: ResolvedTtsConfig,
  provider: TtsProvider | SpeechProviderPlugin,
  cfg?: OpenClawConfig,
): boolean {
  warnPluginSdkDeprecation({
    family: "tts",
    method: "isTtsProviderConfigured",
    replacement: "isTtsProviderConfiguredAsync",
  });
  return isSpeechProviderConfigured(config, provider, cfg, defaultProviderRegistry);
}

function resolveSpeechProviderConfiguration(
  config: ResolvedTtsConfig,
  provider: TtsProvider | SpeechProviderPlugin,
  cfg: OpenClawConfig | undefined,
  registry: TtsProviderRegistry,
) {
  const effectiveCfg = cfg ? resolveProviderRuntimeConfig(cfg, registry) : config.sourceConfig;
  const resolvedProvider =
    typeof provider === "string" ? registry.getSpeechProvider(provider, effectiveCfg) : provider;
  if (!resolvedProvider) {
    return undefined;
  }
  return {
    provider: resolvedProvider,
    context: {
      cfg: effectiveCfg,
      providerConfig: resolveLazyProviderConfig(
        config,
        resolvedProvider.id,
        effectiveCfg,
        undefined,
        resolvedProvider,
        registry,
      ),
      timeoutMs: resolveSpeechProviderTimeoutMs({ config, provider: resolvedProvider }),
    },
  };
}

function isSpeechProviderConfigured(
  config: ResolvedTtsConfig,
  provider: TtsProvider | SpeechProviderPlugin,
  cfg: OpenClawConfig | undefined,
  registry: TtsProviderRegistry,
): boolean {
  try {
    const configured = resolveSpeechProviderConfiguration(config, provider, cfg, registry);
    return configured?.provider.isConfigured(configured.context) ?? false;
  } catch {
    // A broken provider must not hide other usable providers in selection or status.
    return false;
  }
}

export async function isTtsProviderConfiguredAsync(
  config: ResolvedTtsConfig,
  provider: TtsProvider | SpeechProviderPlugin,
  cfg?: OpenClawConfig,
): Promise<boolean> {
  return await isSpeechProviderConfiguredAsync(config, provider, cfg, defaultProviderRegistry);
}

async function isSpeechProviderConfiguredAsync(
  config: ResolvedTtsConfig,
  provider: TtsProvider | SpeechProviderPlugin,
  cfg: OpenClawConfig | undefined,
  registry: TtsProviderRegistry,
): Promise<boolean> {
  try {
    const configured = resolveSpeechProviderConfiguration(config, provider, cfg, registry);
    if (!configured) {
      return false;
    }
    return (
      (await (configured.provider.isConfiguredAsync
        ? configured.provider.isConfiguredAsync(configured.context)
        : configured.provider.isConfigured(configured.context))) ?? false
    );
  } catch {
    // A broken provider must not hide other usable providers in selection or status.
    return false;
  }
}
