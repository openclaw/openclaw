import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString as normalizeLowercaseString,
  normalizeOptionalString as normalizeString,
} from "@openclaw/normalization-core/string-coerce";

export type VoiceModelRef = {
  provider: string;
  model: string;
  timeoutMs?: number;
};

/** Static provider metadata used to validate configured voice model refs. */
export type VoiceModelProvider = {
  id: string;
  aliases?: readonly string[];
  label?: string;
  defaultModel?: string | null;
  models?: readonly string[];
};

export type VoiceProviderCandidate = {
  provider: string;
  voiceModel?: VoiceModelRef;
};

function normalizeTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function parseVoiceModelRef(value: unknown): VoiceModelRef | undefined {
  const parsed = typeof value === "string" ? parseModelCatalogRef(value) : null;
  return parsed ? { provider: parsed.provider, model: parsed.modelId } : undefined;
}

/** Match provider ids case-insensitively across canonical id and aliases. */
export function providerMatchesId(provider: VoiceModelProvider, providerId?: string): boolean {
  const normalized = normalizeLowercaseString(providerId);
  return Boolean(
    normalized &&
    [provider.id, ...(provider.aliases ?? [])].some(
      (id) => normalizeLowercaseString(id) === normalized,
    ),
  );
}

export function voiceProviderSupportsModel(
  provider: VoiceModelProvider | undefined,
  model: unknown,
): boolean {
  if (!provider) {
    return false;
  }
  const normalizedModel = normalizeString(model);
  return [provider.defaultModel, ...(provider.models ?? [])].some(
    (candidate) => normalizeString(candidate) === normalizedModel,
  );
}

export function resolveVoiceModelRefs(config: unknown): VoiceModelRef[] {
  if (typeof config === "string") {
    const parsed = parseVoiceModelRef(config);
    return parsed ? [parsed] : [];
  }
  const voiceModel = asOptionalRecord(config);
  if (!voiceModel) {
    return [];
  }
  const timeoutMs = normalizeTimeoutMs(voiceModel.timeoutMs);
  const refs: VoiceModelRef[] = [];
  const addRef = (value: unknown) => {
    const parsed = parseVoiceModelRef(value);
    if (parsed) {
      refs.push({ ...parsed, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    }
  };
  addRef(voiceModel.primary);
  if (Array.isArray(voiceModel.fallbacks)) {
    for (const fallback of voiceModel.fallbacks) {
      addRef(fallback);
    }
  }
  return refs;
}

export function resolveSupportedVoiceModelRefs(params: {
  config: unknown;
  providers: readonly VoiceModelProvider[];
  providerId?: string;
}): VoiceModelRef[] {
  return resolveVoiceModelRefs(params.config).flatMap((ref) => {
    const provider = params.providers.find((entry) => providerMatchesId(entry, ref.provider));
    if (!provider || (params.providerId && !providerMatchesId(provider, params.providerId))) {
      return [];
    }
    return voiceProviderSupportsModel(provider, ref.model)
      ? [{ ...ref, provider: provider.id }]
      : [];
  });
}

export function resolveVoiceProviderCandidates(params: {
  primaryProvider: string;
  providers: readonly VoiceModelProvider[];
  voiceModelConfig?: unknown;
}): VoiceProviderCandidate[] {
  const primary =
    params.providers.find((provider) => providerMatchesId(provider, params.primaryProvider))?.id ??
    params.primaryProvider;
  const candidates: VoiceProviderCandidate[] = [];
  const seenProviders = new Set<string>();
  const addCandidate = (candidate: VoiceProviderCandidate) => {
    candidates.push(candidate);
    seenProviders.add(candidate.provider);
  };
  const refs = resolveSupportedVoiceModelRefs({
    config: params.voiceModelConfig,
    providers: params.providers,
  });
  const primaryRefs = refs.filter((ref) => ref.provider === primary);
  for (const voiceModel of primaryRefs) {
    addCandidate({ provider: primary, voiceModel });
  }
  if (primaryRefs.length === 0) {
    addCandidate({ provider: primary });
  }
  for (const voiceModel of refs) {
    if (voiceModel.provider !== primary) {
      addCandidate({ provider: voiceModel.provider, voiceModel });
    }
  }
  for (const provider of params.providers) {
    if (!seenProviders.has(provider.id)) {
      addCandidate({ provider: provider.id });
    }
  }
  return candidates;
}

/** Resolve only the primary provider candidate for direct synthesis paths. */
export function resolvePrimaryVoiceProviderCandidate(params: {
  primaryProvider: string;
  providers: readonly VoiceModelProvider[];
  voiceModelConfig?: unknown;
}): VoiceProviderCandidate {
  const provider =
    params.providers.find((entry) => providerMatchesId(entry, params.primaryProvider))?.id ??
    params.primaryProvider;
  const voiceModel = resolveSupportedVoiceModelRefs({
    config: params.voiceModelConfig,
    providers: params.providers,
    providerId: provider,
  })[0];
  return voiceModel ? { provider, voiceModel } : { provider };
}

/** Read provider config by configured id, canonical id, or alias. */
export function getVoiceProviderConfig<TConfig extends Record<string, unknown>>(params: {
  providerConfigs: Record<string, TConfig | undefined>;
  provider: VoiceModelProvider;
  configuredProviderId?: string;
}): TConfig {
  const candidates = [
    normalizeString(params.configuredProviderId),
    params.provider.id,
    ...(params.provider.aliases ?? []),
  ].filter((key): key is string => Boolean(key));
  const configuredKeys = Object.keys(params.providerConfigs);
  for (const candidate of candidates) {
    if (Object.hasOwn(params.providerConfigs, candidate)) {
      return params.providerConfigs[candidate] ?? ({} as TConfig);
    }
    const normalizedCandidate = normalizeLowercaseString(candidate);
    const matchingKey = configuredKeys.find(
      (key) => normalizeLowercaseString(key) === normalizedCandidate,
    );
    if (matchingKey) {
      return params.providerConfigs[matchingKey] ?? ({} as TConfig);
    }
  }
  return {} as TConfig;
}
