/**
 * Sibling Bot Registry
 *
 * Tracks Discord bot user IDs of sibling agents in the same deployment.
 * Messages from sibling bots bypass the standard bot-drop filter so that
 * multi-agent setups can communicate within guild channels.
 *
 * Also maps bot user IDs to their owning agent IDs so that the
 * auto-routing layer can resolve the sender agent for A2A flows.
 *
 * Uses globalThis to guarantee a single shared Map across all bundle
 * chunks (tsdown/rolldown may duplicate module-level state when the
 * same source file is pulled into separate output chunks).
 */

const GLOBAL_KEY = "__openclaw_siblingBotMap__";
const GLOBAL_REVERSE_KEY = "__openclaw_siblingBotReverseMap__";

function getSiblingBotMap(): Map<string, string> {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, string>();
  }
  return g[GLOBAL_KEY] as Map<string, string>;
}

function getSiblingBotReverseMap(): Map<string, string> {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_REVERSE_KEY]) {
    g[GLOBAL_REVERSE_KEY] = new Map<string, string>();
  }
  return g[GLOBAL_REVERSE_KEY] as Map<string, string>;
}

/** Register a bot user ID as a sibling agent. */
export function registerSiblingBot(botId: string, agentId?: string): void {
  if (botId) {
    // Clean up old reverse mapping before overwriting
    const oldAgentId = getSiblingBotMap().get(botId);
    if (oldAgentId) {
      getSiblingBotReverseMap().delete(oldAgentId);
    }
    getSiblingBotMap().set(botId, agentId ?? "");
    if (agentId) {
      getSiblingBotReverseMap().set(agentId, botId);
    }
  }
}

/** Unregister a bot user ID when an account disconnects. */
export function unregisterSiblingBot(botId: string): void {
  const agentId = getSiblingBotMap().get(botId);
  getSiblingBotMap().delete(botId);
  if (agentId) {
    getSiblingBotReverseMap().delete(agentId);
  }
}

/** Check whether a user ID belongs to a registered sibling bot. */
export function isSiblingBot(userId: string): boolean {
  return getSiblingBotMap().has(userId);
}

/**
 * Resolve the agent ID that owns a given Discord bot user ID.
 * Returns `undefined` if the bot is not registered or has no agent mapping.
 */
export function getAgentIdForBot(botUserId: string): string | undefined {
  const agentId = getSiblingBotMap().get(botUserId);
  return agentId || undefined;
}

/** Resolve the Discord bot user ID for a given agent ID. */
export function getBotUserIdForAgent(agentId: string): string | undefined {
  return getSiblingBotReverseMap().get(agentId);
}

/**
 * 2-stage lookup: resolve agentId to Discord bot user ID.
 * Stage 1: direct lookup by agentId in reverse map
 * Stage 2: fallback via config binding (agentId → accountId → botUserId)
 */
export function resolveAgentBotUserId(
  agentId: string,
  cfg?: { bindings?: Array<{ accountId: string; agentId?: string }> },
): string | undefined {
  // Stage 1: direct lookup
  const direct = getBotUserIdForAgent(agentId);
  if (direct) {
    return direct;
  }

  // Stage 2: try config bindings to find accountId for this agentId
  if (cfg?.bindings) {
    for (const binding of cfg.bindings) {
      if (binding.agentId === agentId && binding.accountId) {
        const fallback = getBotUserIdForAgent(binding.accountId);
        if (fallback) {
          return fallback;
        }
      }
    }
  }

  return undefined;
}

/** Return all registered sibling bot IDs (for diagnostics). */
export function listSiblingBots(): string[] {
  return [...getSiblingBotMap().keys()];
}

/** Clear all registrations (for tests). */
export function clearSiblingBots(): void {
  getSiblingBotMap().clear();
  getSiblingBotReverseMap().clear();
}
