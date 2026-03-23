/**
 * Bot Name Registry
 *
 * A process-level store that maps accountId → bot display name.
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

/** Register or update the bot display name for a given accountId. */
export function registerBotName(accountId: string, botName: string): void {
  getRegistry().set(accountId, botName);
}

/** Remove the bot name entry for a given accountId (e.g. on monitor stop). */
export function unregisterBotName(accountId: string): void {
  getRegistry().delete(accountId);
}

/**
 * Look up the bot display name for a given accountId.
 * Returns undefined if no name has been registered for this account.
 */
export function getBotName(accountId: string): string | undefined {
  return getRegistry().get(accountId);
}

/**
 * Resolve a bot name from the first matching accountId found in the
 * provided list of candidate IDs. Useful when only a channelId is
 * available and it encodes the accountId (e.g. "feishu/cli_xxx").
 */
export function resolveBotName(candidateIds: Array<string | undefined>): string | undefined {
  const registry = getRegistry();
  for (const id of candidateIds) {
    if (!id) {
      continue;
    }
    const name = registry.get(id);
    if (name) {
      return name;
    }
  }
  return undefined;
}
