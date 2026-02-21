/**
 * /agent command handler — switch the active agent for the current chat.
 *
 * Usage:
 *   /agent           → show which agent is currently handling this chat
 *   /agent <id>      → switch to agent <id> for this chat
 *   /agent default   → clear override, revert to default routing
 */

import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearDynamicAgentOverride,
  getCurrentDynamicAgent,
  setDynamicAgentOverride,
} from "../../routing/dynamic-bindings.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { CommandHandler } from "./commands-types.js";

function listAgentIds(cfg: OpenClawConfig): string[] {
  const agents = cfg.agents?.list;
  if (!Array.isArray(agents)) {
    return [];
  }
  return agents
    .map((agent) => (typeof agent === "object" && agent?.id ? agent.id.trim() : ""))
    .filter(Boolean);
}

function resolveChannelAndPeerId(params: {
  channel?: string;
  from?: string;
  to?: string;
  senderId?: string;
  chatType?: string;
}): { channel: string; peerId: string } | null {
  const channel = params.channel?.trim().toLowerCase();
  if (!channel) {
    return null;
  }

  // For direct chats, use senderId or extract from "channel:id" format
  let peerId = params.senderId?.trim() || "";

  if (!peerId) {
    // Try to extract from 'from' field (format: "telegram:123456" or "group:123456")
    const from = params.from?.trim() || "";
    const colonIndex = from.indexOf(":");
    if (colonIndex > 0) {
      peerId = from.substring(colonIndex + 1);
    }
  }

  if (!peerId) {
    return null;
  }

  return { channel, peerId };
}

export const handleAgentCommand: CommandHandler = async (params, allowTextCommands) => {
  const { command, cfg } = params;
  const body = command.commandBodyNormalized;

  // Match /agent with optional argument
  const match = body.match(/^\/(agent)(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }

  const isNative = params.ctx.CommandSource === "native";
  if (!isNative && !allowTextCommands) {
    return null;
  }

  if (!command.isAuthorizedSender) {
    return {
      shouldContinue: false,
      reply: { text: "You are not authorized to switch agents." },
    };
  }

  const channelInfo = resolveChannelAndPeerId({
    channel: command.channel,
    from: command.from,
    to: command.to,
    senderId: command.senderId,
    chatType: params.ctx.ChatType,
  });

  if (!channelInfo) {
    return {
      shouldContinue: false,
      reply: { text: "Could not determine chat context for agent switching." },
    };
  }

  const { channel, peerId } = channelInfo;
  const rawArg = match[2]?.trim() || "";

  // /agent (no args) — show current
  if (!rawArg) {
    const currentOverride = getCurrentDynamicAgent(channel, peerId);
    const defaultAgent = resolveDefaultAgentId(cfg);
    const available = listAgentIds(cfg);

    const lines: string[] = [];
    if (currentOverride) {
      lines.push(`Active agent: **${currentOverride}** (override)`);
      lines.push(`Default: ${defaultAgent}`);
    } else {
      lines.push(`Active agent: **${defaultAgent}** (default)`);
    }
    if (available.length > 0) {
      lines.push(`\nAvailable: ${available.join(", ")}`);
    }
    lines.push(`\nUse \`/agent <id>\` to switch or \`/agent default\` to reset.`);

    return {
      shouldContinue: false,
      reply: { text: lines.join("\n") },
    };
  }

  // /agent default — clear override
  if (rawArg.toLowerCase() === "default" || rawArg.toLowerCase() === "reset") {
    clearDynamicAgentOverride(channel, peerId);
    const defaultAgent = resolveDefaultAgentId(cfg);
    return {
      shouldContinue: false,
      reply: {
        text: `Agent reset to default routing (**${defaultAgent}**). Next message will be handled by the default agent.`,
      },
    };
  }

  // /agent <id> — switch to specific agent
  const requestedId = rawArg;
  const normalizedRequested = normalizeAgentId(requestedId);
  const available = listAgentIds(cfg);
  const matchedAgent = available.find(
    (agentId) => normalizeAgentId(agentId) === normalizedRequested,
  );

  if (!matchedAgent) {
    return {
      shouldContinue: false,
      reply: {
        text: `Agent "${requestedId}" not found.\n\nAvailable agents: ${available.join(", ") || "(none)"}`,
      },
    };
  }

  setDynamicAgentOverride(channel, peerId, matchedAgent);

  return {
    shouldContinue: false,
    reply: {
      text: `Switched to agent **${matchedAgent}**. Next messages will be handled by this agent.\n\nUse \`/agent default\` to revert.`,
    },
  };
};
