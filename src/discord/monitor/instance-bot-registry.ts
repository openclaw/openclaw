/**
 * Module-level registry of bot user IDs for all Discord accounts
 * managed by this OpenClaw instance.
 *
 * Used to distinguish "own instance" bots from external bots when
 * filtering inbound messages. Messages from other bots in the same
 * instance should not be blocked by the allowBots=false default,
 * enabling agent-to-agent communication via Discord.
 *
 * Fixes: https://github.com/openclaw/openclaw/issues/11199
 */

const instanceBotUserIds = new Set<string>();

/** Register a bot user ID belonging to this OpenClaw instance. */
export function registerInstanceBotUserId(botUserId: string): void {
  if (botUserId) {
    instanceBotUserIds.add(botUserId);
  }
}

/** Unregister a bot user ID (e.g. on account shutdown). */
export function unregisterInstanceBotUserId(botUserId: string): void {
  instanceBotUserIds.delete(botUserId);
}

/**
 * Check if a given user ID belongs to another bot in this OpenClaw instance
 * (excluding the caller's own bot ID).
 */
export function isInstanceBotUserId(userId: string, ownBotUserId?: string): boolean {
  if (!userId) {
    return false;
  }
  // Don't match the caller's own bot — that's handled by the self-message check
  if (ownBotUserId && userId === ownBotUserId) {
    return false;
  }
  return instanceBotUserIds.has(userId);
}

/** Clear all registered bot user IDs (for testing). */
export function clearInstanceBotUserIds(): void {
  instanceBotUserIds.clear();
}
