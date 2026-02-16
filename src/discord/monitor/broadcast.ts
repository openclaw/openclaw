import type { HistoryEntry } from "../../auto-reply/reply/history.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import { buildAgentSessionKey } from "../../routing/resolve-route.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
} from "../../routing/session-key.js";
import { getChildLogger } from "../../logging.js";
import { formatError } from "../../web/session.js";

const discordBroadcastLog = getChildLogger({ module: "discord-auto-reply" });

export async function maybeBroadcastDiscordMessage(params: {
  ctx: DiscordMessagePreflightContext;
  processMessage: (
    ctx: DiscordMessagePreflightContext,
    opts?: {
      guildHistory?: HistoryEntry[];
      suppressGuildHistoryClear?: boolean;
    },
  ) => Promise<void>;
}) {
  if (!params.ctx.isGuildMessage) {
    return false;
  }

  const broadcastAgents = params.ctx.cfg.broadcast?.[params.ctx.messageChannelId];
  if (!broadcastAgents || !Array.isArray(broadcastAgents)) {
    return false;
  }
  if (broadcastAgents.length === 0) {
    return false;
  }

  const strategy = params.ctx.cfg.broadcast?.strategy || "parallel";
  discordBroadcastLog.info(
    `Broadcasting message to ${broadcastAgents.length} agents (${strategy})`,
  );

  const agentIds = params.ctx.cfg.agents?.list?.map((agent) => normalizeAgentId(agent.id));
  const hasKnownAgents = (agentIds?.length ?? 0) > 0;
  const guildHistorySnapshot = params.ctx.guildHistories.get(params.ctx.messageChannelId) ?? [];

  const processForAgent = async (agentId: string): Promise<void> => {
    const normalizedAgentId = normalizeAgentId(agentId);
    if (hasKnownAgents && !agentIds?.includes(normalizedAgentId)) {
      discordBroadcastLog.warn(`Broadcast agent ${agentId} not found in agents.list; skipping`);
      return;
    }

    const agentRoute = {
      ...params.ctx.route,
      agentId: normalizedAgentId,
      sessionKey: buildAgentSessionKey({
        agentId: normalizedAgentId,
        channel: "discord",
        accountId: params.ctx.route.accountId,
        peer: {
          kind: "channel",
          id: params.ctx.messageChannelId,
        },
        dmScope: params.ctx.cfg.session?.dmScope,
        identityLinks: params.ctx.cfg.session?.identityLinks,
      }),
      mainSessionKey: buildAgentMainSessionKey({
        agentId: normalizedAgentId,
        mainKey: DEFAULT_MAIN_KEY,
      }),
    };

    const agentCtx: DiscordMessagePreflightContext = {
      ...params.ctx,
      route: agentRoute,
      baseSessionKey: agentRoute.sessionKey,
    };

    try {
      await params.processMessage(agentCtx, {
        guildHistory: guildHistorySnapshot,
        suppressGuildHistoryClear: true,
      });
    } catch (err) {
      discordBroadcastLog.error(`Broadcast agent ${agentId} failed: ${formatError(err)}`);
    }
  };

  if (strategy === "sequential") {
    for (const agentId of broadcastAgents) {
      await processForAgent(agentId);
    }
  } else {
    await Promise.allSettled(broadcastAgents.map(processForAgent));
  }

  params.ctx.guildHistories.set(params.ctx.messageChannelId, []);
  return true;
}
