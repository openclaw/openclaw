import type { HistoryEntry } from "../../auto-reply/reply/history.js";
import { getChildLogger } from "../../logging.js";
import { buildAgentSessionKey } from "../../routing/resolve-route.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
} from "../../routing/session-key.js";
import { formatError } from "../../web/session.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";

const discordBroadcastLog = getChildLogger({ module: "discord-auto-reply" });

export async function maybeBroadcastDiscordMessage(params: {
  ctx: DiscordMessagePreflightContext;
  processMessage: (
    ctx: DiscordMessagePreflightContext,
    opts?: {
      guildHistory?: HistoryEntry[];
      suppressGuildHistoryClear?: boolean;
      agentIdentity?: {
        name?: string;
        emoji?: string;
        avatar?: string;
      };
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
  const agentConfigById = new Map(
    (params.ctx.cfg.agents?.list ?? []).map((agent) => [normalizeAgentId(agent.id), agent]),
  );
  const hasKnownAgents = (agentIds?.length ?? 0) > 0;
  const guildHistorySnapshot = params.ctx.guildHistories.get(params.ctx.messageChannelId) ?? [];

  // If this message came from one of our own broadcast webhooks, identify the
  // sending agent so we can exclude it from the fan-out (prevent self-loop).
  //
  // Discord strips Unicode Variation Selectors (VS16 U+FE0F) and Zero-Width
  // Joiners (U+200D) from webhook usernames, so we must normalize both sides
  // before comparing to avoid identity mismatches that cause infinite loops.
  const stripEmojiModifiers = (s: string) =>
    s.replace(/[\uFE0F\u200D]/g, "").trim().toLowerCase();

  let excludeAgentId: string | undefined;
  if (params.ctx.ownWebhookUsername) {
    const webhookName = stripEmojiModifiers(params.ctx.ownWebhookUsername);
    for (const [id, agent] of agentConfigById) {
      const displayName = [agent.identity?.name?.trim(), agent.identity?.emoji?.trim()]
        .filter(Boolean)
        .join(" ");
      const normalizedDisplay = stripEmojiModifiers(displayName);
      if (normalizedDisplay && webhookName === normalizedDisplay) {
        excludeAgentId = id;
        break;
      }
      // Also match name-only (without emoji)
      const nameOnly = (agent.identity?.name ?? agent.name ?? "").trim();
      const normalizedName = stripEmojiModifiers(nameOnly);
      if (normalizedName && webhookName.startsWith(normalizedName)) {
        excludeAgentId = id;
        break;
      }
    }
    if (excludeAgentId) {
      discordBroadcastLog.info(`Excluding source agent "${excludeAgentId}" from broadcast`);
    }
  }

  const processForAgent = async (agentId: string): Promise<void> => {
    const normalizedAgentId = normalizeAgentId(agentId);
    if (excludeAgentId && normalizedAgentId === excludeAgentId) {
      discordBroadcastLog.info(`Skipping broadcast to "${agentId}" (source agent)`);
      return;
    }
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
    const agentConfig = agentConfigById.get(normalizedAgentId);
    const identity = agentConfig?.identity;
    const agentIdentity = {
      name: identity?.name ?? agentConfig?.name ?? normalizedAgentId,
      emoji: identity?.emoji,
      avatar: identity?.avatar,
    };

    try {
      await params.processMessage(agentCtx, {
        guildHistory: guildHistorySnapshot,
        suppressGuildHistoryClear: true,
        agentIdentity,
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
