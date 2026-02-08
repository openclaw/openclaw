/**
 * Module-level registry of Discord bot user IDs for all configured accounts.
 * Used to identify "sibling bots" -- bots belonging to the same OpenClaw
 * instance but running under a different Discord account.  Messages from
 * sibling bots should bypass bot filtering and mention gating so multi-agent
 * setups work correctly.
 *
 * Follows the same pattern as gateway-registry.ts.
 */
const siblingBotRegistry = new Map<string, string>();

/** Register a bot user ID for a Discord account. */
export function registerSiblingBot(accountId: string, botUserId: string): void {
  siblingBotRegistry.set(accountId, botUserId);
}

/** Unregister a bot user ID when a Discord account shuts down. */
export function unregisterSiblingBot(accountId: string): void {
  siblingBotRegistry.delete(accountId);
}

/**
 * Check whether `userId` belongs to a sibling bot -- i.e. a *different*
 * configured Discord account in the same OpenClaw instance.
 *
 * Returns `false` for the caller's own bot user ID (that case is already
 * handled by the self-message check) and for unknown user IDs.
 */
export function isSiblingBot(currentAccountId: string, userId: string): boolean {
  for (const [accountId, botUserId] of siblingBotRegistry) {
    if (accountId === currentAccountId) {
      continue;
    }
    if (botUserId === userId) {
      return true;
    }
  }
  return false;
}

/** Clear all registered sibling bots (for testing). */
export function clearSiblingBots(): void {
  siblingBotRegistry.clear();
}
