/**
 * Dynamic bag of per-channel send functions, keyed by channel ID.
 * Each outbound adapter resolves its own function from this record and
 * falls back to a direct import when the key is absent.
 */
export type OutboundSendDeps = { [channelId: string]: unknown };

/**
 * Extra historical keys to try after the normalized channel-derived keys.
 */
export type ResolveOutboundSendDepOptions = {
  legacyKeys?: readonly string[];
};

/**
 * Resolves a channel send dependency from modern channel IDs or legacy helper keys.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Channel-specific dependency lookup returns caller-typed values.
export function resolveOutboundSendDep<T>(
  deps: OutboundSendDeps | null | undefined,
  channelId: string,
  options?: ResolveOutboundSendDepOptions,
): T | undefined {
  const dynamic = deps?.[channelId];
  if (dynamic !== undefined) {
    return dynamic as T;
  }
  const compact = channelId.replace(/[^a-z0-9]+/gi, "");
  const pascal = compact.charAt(0).toUpperCase() + compact.slice(1);
  const legacyKeys = [
    ...(compact
      ? pascal.startsWith("Ms") && pascal.length > 2
        ? [`send${pascal}`, `sendMS${pascal.slice(2)}`]
        : [`send${pascal}`]
      : []),
    ...(options?.legacyKeys ?? []),
  ];
  for (const legacyKey of legacyKeys) {
    const legacy = deps?.[legacyKey];
    if (legacy !== undefined) {
      return legacy as T;
    }
  }
  return undefined;
}
