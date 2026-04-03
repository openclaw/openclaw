/**
 * Dynamic bag of per-channel send functions, keyed by channel ID.
 * Each outbound adapter resolves its own function from this record and
 * falls back to a direct import when the key is absent.
 */
export type OutboundSendDeps = { [channelId: string]: unknown };

function resolveLegacyDepKeysForChannel(channelId: string): string[] {
  const compact = channelId.replace(/[^a-z0-9]+/gi, "");
  if (!compact) {
    return [];
  }
  const pascal = compact.charAt(0).toUpperCase() + compact.slice(1);
  const keys = new Set<string>();
  keys.add(`send${pascal}`);
  if (pascal.startsWith("I") && pascal.length > 1) {
    keys.add(`sendI${pascal.slice(1)}`);
  }
  if (pascal.startsWith("Ms") && pascal.length > 2) {
    keys.add(`sendMS${pascal.slice(2)}`);
  }
  return [...keys];
}

export type ResolveOutboundSendDepOptions = {
  legacyKeys?: readonly string[];
};

export function resolveOutboundSendDep<T>(
  deps: OutboundSendDeps | null | undefined,
  channelId: string,
  options?: ResolveOutboundSendDepOptions,
): T | undefined {
  const dynamic = deps?.[channelId];
  if (dynamic !== undefined) {
    return dynamic as T;
  }
  const legacyKeys = [...resolveLegacyDepKeysForChannel(channelId), ...(options?.legacyKeys ?? [])];
  for (const legacyKey of legacyKeys) {
    const legacy = deps?.[legacyKey];
    if (legacy !== undefined) {
      return legacy as T;
    }
  }
  return undefined;
}
