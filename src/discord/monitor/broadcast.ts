import type { loadConfig } from "../../config/config.js";
import type { resolveAgentRoute } from "../../routing/resolve-route.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildAgentSessionKey } from "../../routing/resolve-route.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
} from "../../routing/session-key.js";

const broadcastLog = createSubsystemLogger("discord/broadcast");

/**
 * Check if a Discord channel is configured for broadcast routing.
 * Returns the list of agent IDs that should receive the message, or null if not broadcast.
 */
export function resolveDiscordBroadcastAgents(params: {
  cfg: ReturnType<typeof loadConfig>;
  channelId: string;
}): string[] | null {
  const broadcastConfig = params.cfg.broadcast;
  if (!broadcastConfig) {
    return null;
  }

  // Check for channel ID match (Discord uses channel IDs as peer identifiers)
  const agents = broadcastConfig[params.channelId];
  if (Array.isArray(agents) && agents.length > 0) {
    return agents;
  }

  // Also check with discord: prefix for explicit Discord routing
  const prefixedKey = `discord:${params.channelId}`;
  const prefixedAgents = broadcastConfig[prefixedKey];
  if (Array.isArray(prefixedAgents) && prefixedAgents.length > 0) {
    return prefixedAgents;
  }

  return null;
}

/**
 * Build a route override for a specific agent in broadcast mode.
 */
export function buildBroadcastRoute(params: {
  cfg: ReturnType<typeof loadConfig>;
  baseRoute: ReturnType<typeof resolveAgentRoute>;
  agentId: string;
  channelId: string;
  isDirectMessage: boolean;
  authorId: string;
}): ReturnType<typeof resolveAgentRoute> {
  const normalizedAgentId = normalizeAgentId(params.agentId);
  const peerKind = params.isDirectMessage ? "dm" : "channel";
  const peerId = params.isDirectMessage ? params.authorId : params.channelId;

  const sessionKey = buildAgentSessionKey({
    agentId: normalizedAgentId,
    channel: "discord",
    accountId: params.baseRoute.accountId,
    peer: { kind: peerKind, id: peerId },
    dmScope: params.cfg.session?.dmScope,
    identityLinks: params.cfg.session?.identityLinks,
  });

  const mainSessionKey = buildAgentMainSessionKey({
    agentId: normalizedAgentId,
    mainKey: DEFAULT_MAIN_KEY,
  });

  return {
    ...params.baseRoute,
    agentId: normalizedAgentId,
    sessionKey,
    mainSessionKey,
    matchedBy: "binding.channel", // Indicate this came from broadcast
  };
}

/**
 * Process a message for all agents configured in broadcast mode.
 * Returns true if broadcast was handled, false if normal routing should proceed.
 */
export async function maybeProcessDiscordBroadcast(params: {
  cfg: ReturnType<typeof loadConfig>;
  ctx: DiscordMessagePreflightContext;
  processMessage: (ctx: DiscordMessagePreflightContext) => Promise<void>;
}): Promise<boolean> {
  const { cfg, ctx, processMessage } = params;
  const channelId = ctx.message.channelId;

  const broadcastAgents = resolveDiscordBroadcastAgents({ cfg, channelId });
  if (!broadcastAgents || broadcastAgents.length === 0) {
    return false;
  }

  // Validate agent IDs exist in config
  const knownAgentIds = cfg.agents?.list?.map((agent) => normalizeAgentId(agent.id)) ?? [];
  const validAgents = broadcastAgents.filter((agentId) => {
    const normalized = normalizeAgentId(agentId);
    if (knownAgentIds.length > 0 && !knownAgentIds.includes(normalized)) {
      broadcastLog.warn(`Broadcast agent ${agentId} not found in agents.list; skipping`);
      return false;
    }
    return true;
  });

  if (validAgents.length === 0) {
    broadcastLog.warn(`No valid agents for broadcast on channel ${channelId}`);
    return false;
  }

  const strategy = cfg.broadcast?.strategy ?? "parallel";
  broadcastLog.info(`Broadcasting Discord message to ${validAgents.length} agents (${strategy})`, {
    channelId,
    agents: validAgents,
  });

  const processForAgent = async (agentId: string): Promise<void> => {
    const agentRoute = buildBroadcastRoute({
      cfg,
      baseRoute: ctx.route,
      agentId,
      channelId,
      isDirectMessage: ctx.isDirectMessage,
      authorId: ctx.author.id,
    });

    // Create a new context with the overridden route
    const agentCtx: DiscordMessagePreflightContext = {
      ...ctx,
      route: agentRoute,
      baseSessionKey: agentRoute.sessionKey,
    };

    try {
      await processMessage(agentCtx);
    } catch (err) {
      broadcastLog.error(`Broadcast agent ${agentId} failed: ${String(err)}`);
    }
  };

  if (strategy === "sequential") {
    for (const agentId of validAgents) {
      await processForAgent(agentId);
    }
  } else {
    await Promise.allSettled(validAgents.map(processForAgent));
  }

  return true;
}
