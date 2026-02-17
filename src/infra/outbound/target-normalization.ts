import type { ChannelId } from "../../channels/plugins/types.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";

export function normalizeChannelTargetInput(raw: string): string {
  return raw.trim();
}

export function normalizeTargetForProvider(provider: string, raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const providerId = normalizeChannelId(provider);
  const plugin = providerId ? getChannelPlugin(providerId) : undefined;
  const normalized = plugin?.messaging?.normalizeTarget?.(raw) ?? (raw.trim() || undefined);
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
