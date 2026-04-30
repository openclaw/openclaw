import { normalizeProviderId } from "../agents/provider-id.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { listBundledPluginMetadata } from "./bundled-plugin-metadata.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
  ProviderThinkingPolicyContext,
} from "./provider-thinking.types.js";

type ThinkingProviderPlugin = {
  id: string;
  aliases?: string[];
  hookAliases?: string[];
  isBinaryThinking?: (ctx: ProviderThinkingPolicyContext) => boolean | undefined;
  supportsXHighThinking?: (ctx: ProviderThinkingPolicyContext) => boolean | undefined;
  resolveThinkingProfile?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => ProviderThinkingProfile | null | undefined;
  resolveDefaultThinkingLevel?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | null | undefined;
};

type BundledThinkingCompat = {
  supportedReasoningEfforts?: readonly string[];
};

const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

const runtimeThinkingCompatCache = new Map<string, BundledThinkingCompat | null>();

type ThinkingRegistryState = {
  activeRegistry?: {
    providers?: Array<{
      provider: ThinkingProviderPlugin;
    }>;
  } | null;
};

function matchesProviderId(provider: ThinkingProviderPlugin, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) {
    return false;
  }
  if (normalizeProviderId(provider.id) === normalized) {
    return true;
  }
  return [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
    (alias) => normalizeProviderId(alias) === normalized,
  );
}

function resolveActiveThinkingProvider(providerId: string): ThinkingProviderPlugin | undefined {
  const state = (
    globalThis as typeof globalThis & { [PLUGIN_REGISTRY_STATE]?: ThinkingRegistryState }
  )[PLUGIN_REGISTRY_STATE];
  const activeProvider = state?.activeRegistry?.providers?.find((entry) => {
    return matchesProviderId(entry.provider, providerId);
  })?.provider;
  if (activeProvider) {
    return activeProvider;
  }
  return undefined;
}

function findBundledThinkingCompat(
  providerId: string,
  modelId: string,
): BundledThinkingCompat | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  const normalizedModelId = normalizeOptionalLowercaseString(modelId);
  if (!normalizedProviderId || !normalizedModelId) {
    return null;
  }

  const cacheKey = `${normalizedProviderId}\u0000${normalizedModelId}`;
  const cached = runtimeThinkingCompatCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  for (const entry of listBundledPluginMetadata({ includeChannelConfigs: false })) {
    const providerCatalog = entry.manifest.modelCatalog?.providers?.[normalizedProviderId];
    const models = providerCatalog?.models;
    if (!Array.isArray(models)) {
      continue;
    }
    const match = models.find((model) => {
      const candidateId = normalizeOptionalLowercaseString(
        typeof model?.id === "string" ? model.id : undefined,
      );
      return candidateId === normalizedModelId;
    }) as { compat?: BundledThinkingCompat } | undefined;
    const compat = match?.compat ?? null;
    runtimeThinkingCompatCache.set(cacheKey, compat);
    return compat;
  }

  runtimeThinkingCompatCache.set(cacheKey, null);
  return null;
}

function resetBundledThinkingCompatCacheForTest(): void {
  runtimeThinkingCompatCache.clear();
}

export const __testing = {
  resetBundledThinkingCompatCacheForTest,
} as const;

type ThinkingHookParams<TContext> = {
  provider: string;
  context: TContext;
};

export function resolveProviderBinaryThinking(
  params: ThinkingHookParams<ProviderThinkingPolicyContext>,
) {
  return resolveActiveThinkingProvider(params.provider)?.isBinaryThinking?.(params.context);
}

export function resolveProviderXHighThinking(
  params: ThinkingHookParams<ProviderThinkingPolicyContext>,
) {
  const runtime = resolveActiveThinkingProvider(params.provider)?.supportsXHighThinking?.(params.context);
  if (runtime !== undefined) {
    return runtime;
  }
  const compat = findBundledThinkingCompat(params.provider, params.context.modelId);
  return compat?.supportedReasoningEfforts?.some(
    (effort) => normalizeOptionalString(effort)?.toLowerCase() === "xhigh",
  )
    ? true
    : undefined;
}

export function resolveProviderThinkingProfile(
  params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>,
) {
  return resolveActiveThinkingProvider(params.provider)?.resolveThinkingProfile?.(params.context);
}

export function resolveProviderDefaultThinkingLevel(
  params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>,
) {
  return resolveActiveThinkingProvider(params.provider)?.resolveDefaultThinkingLevel?.(
    params.context,
  );
}
