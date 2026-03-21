import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import { getActivePluginRegistryVersion } from "../../plugins/runtime.js";

export function normalizeChannelTargetInput(raw: string): string {
  return raw.trim();
}

type TargetNormalizer = ((raw: string) => string | undefined) | undefined;
type TargetNormalizerCacheEntry = {
  version: number;
  normalizer: TargetNormalizer;
};

const targetNormalizerCacheByChannelId = new Map<string, TargetNormalizerCacheEntry>();
const TARGET_NORMALIZER_CACHE_MAX = 256;

function resolveTargetNormalizer(channelId: ChannelId): TargetNormalizer {
  const version = getActivePluginRegistryVersion();
  const cached = targetNormalizerCacheByChannelId.get(channelId);
  if (cached?.version === version) {
    return cached.normalizer;
  }
  const plugin = getChannelPlugin(channelId);
  const normalizer = plugin?.messaging?.normalizeTarget;
  targetNormalizerCacheByChannelId.set(channelId, {
    version,
    normalizer,
  });
  if (targetNormalizerCacheByChannelId.size > TARGET_NORMALIZER_CACHE_MAX) {
    const oldest = targetNormalizerCacheByChannelId.keys().next();
    if (!oldest.done) {
      targetNormalizerCacheByChannelId.delete(oldest.value);
    }
  }
  return normalizer;
}

export function normalizeTargetForProvider(provider: string, raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const fallback = raw.trim() || undefined;
  if (!fallback) {
    return undefined;
  }
  const providerId = normalizeChannelId(provider);
  const normalizer = providerId ? resolveTargetNormalizer(providerId) : undefined;
  const normalized = normalizer?.(raw) ?? fallback;
  return normalized || undefined;
}

export function buildTargetResolverSignature(channel: ChannelId): string {
  const plugin = getChannelPlugin(channel);
  const resolver = plugin?.messaging?.targetResolver;
  const hint = resolver?.hint ?? "";
  const looksLike = resolver?.looksLikeId;
  const source = looksLike ? looksLike.toString() : "";
  return hashSignature(`${hint}|${source}`);
}

function hashSignature(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
