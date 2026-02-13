import type { MsgContext } from "../../auto-reply/templating.js";
import type { SessionScope } from "./types.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  normalizeMainKey,
} from "../../routing/session-key.js";
import { normalizeE164 } from "../../utils.js";
import { resolveGroupSessionKey } from "./group.js";

// Decide which session bucket to use (per-sender vs global).
export function deriveSessionKey(scope: SessionScope, ctx: MsgContext) {
  if (scope === "global") {
    return "global";
  }
  const resolvedGroup = resolveGroupSessionKey(ctx);
  if (resolvedGroup) {
    return resolvedGroup.key;
  }
  const from = ctx.From ? normalizeE164(ctx.From) : "";
  return from || "unknown";
}

/**
 * Resolve the session key with a canonical direct-chat bucket (default: "main").
 * All non-group direct chats collapse to this bucket; groups stay isolated.
 */
export function resolveSessionKey(scope: SessionScope, ctx: MsgContext, mainKey?: string) {
  const explicit = ctx.SessionKey?.trim();
  if (explicit) {
    let normalized = explicit.toLowerCase();

    // Fix misrouted Discord DM session keys:
    // When chatType is "direct", the session key should use discord:direct:
    // instead of discord:dm: (legacy) or discord:channel: (phantom).
    const chatType = normalizeChatType(ctx.ChatType);
    if (chatType === "direct") {
      // Migrate legacy discord:dm: → discord:direct:
      normalized = normalized.replace(/^(agent:[^:]+:discord:)dm:/, "$1direct:");

      // Fix phantom discord:channel:USERID → discord:direct:USERID
      // This happens when parseDiscordTarget treats a bare user ID as a channel.
      const match = normalized.match(/^((?:agent:[^:]+:)?)discord:channel:([^:]+)$/);
      if (match) {
        const from = (ctx.From ?? "").trim().toLowerCase();
        const senderId = (ctx.SenderId ?? "").trim().toLowerCase();
        const fromDiscordId =
          from.startsWith("discord:") && !from.includes(":channel:") && !from.includes(":group:")
            ? from.slice("discord:".length)
            : "";
        const directId = senderId || fromDiscordId;
        if (directId && directId === match[2]) {
          normalized = `${match[1]}discord:direct:${match[2]}`;
        }
      }
    }

    return normalized;
  }
  const raw = deriveSessionKey(scope, ctx);
  if (scope === "global") {
    return raw;
  }
  const canonicalMainKey = normalizeMainKey(mainKey);
  const canonical = buildAgentMainSessionKey({
    agentId: DEFAULT_AGENT_ID,
    mainKey: canonicalMainKey,
  });
  const isGroup = raw.includes(":group:") || raw.includes(":channel:");
  if (!isGroup) {
    return canonical;
  }
  return `agent:${DEFAULT_AGENT_ID}:${raw}`;
}
