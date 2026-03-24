/**
 * Bot Name Registry
 *
 * A process-level store that maps (channelId, accountId) → bot display name.
 * Channel providers (e.g. Feishu) write here when they resolve a bot
 * identity; the hook runner reads here to inject `bot_name` into every
 * hook event so plugins can see the bot name without coupling to a
 * specific channel implementation.
 */

const botNameRegistryKey = Symbol.for("openclaw.plugins.bot-name-registry");

function getRegistry(): Map<string, string> {
  const g = globalThis as typeof globalThis & {
    [botNameRegistryKey]?: Map<string, string>;
  };
  return (g[botNameRegistryKey] ??= new Map());
}

// Null byte cannot appear in channelId or accountId, making it a safe delimiter.
function makeKey(channelId: string, accountId: string): string {
  return `${channelId}\x00${accountId}`;
}

/** Register or update the bot display name for a given (channelId, accountId) pair. */
export function registerBotName(channelId: string, accountId: string, botName: string): void {
  getRegistry().set(makeKey(channelId, accountId), botName);
}

/** Remove the bot name entry for a given (channelId, accountId) pair (e.g. on monitor stop). */
export function unregisterBotName(channelId: string, accountId: string): void {
  getRegistry().delete(makeKey(channelId, accountId));
}

/**
 * Look up the bot display name for a given (channelId, accountId) pair.
 * Returns undefined if no name has been registered for this combination.
 */
export function getBotName(channelId: string, accountId: string): string | undefined {
  return getRegistry().get(makeKey(channelId, accountId));
}

/**
 * Resolve the bot display name for a (channelId, accountId) pair.
 * Falls back to (channelId, "default") when accountId is absent —
 * covers agent hooks that carry channelId but no accountId.
 */
export function resolveBotName(
  channelId: string | undefined,
  accountId: string | undefined,
): string | undefined {
  if (!channelId) {
    return undefined;
  }
  const registry = getRegistry();
  if (accountId) {
    // Explicit accountId: do not fall back to "default" on a miss, which would
    // mislabel events from one account as another account's bot.
    return registry.get(makeKey(channelId, accountId));
  }
  return registry.get(makeKey(channelId, "default"));
}
