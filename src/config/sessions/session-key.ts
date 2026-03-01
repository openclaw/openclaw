import type { MsgContext } from "../../auto-reply/templating.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  normalizeMainKey,
} from "../../routing/session-key.js";
import { normalizeE164 } from "../../utils.js";
import { resolveGroupSessionKey } from "./group.js";
import type { SessionScope } from "./types.js";

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

export type ResolveSessionKeyOptions = {
  mainKey?: string;
  sessionLinks?: Record<string, string[]>;
};

/**
 * Build a conversation identifier for sessionLinks matching.
 * Format: "{channel}:{type}:{id}"
 * Examples: "feishu:group:oc_xxx", "wechat:direct:wxid_xxx"
 */
function buildConversationId(ctx: MsgContext): string | null {
  const groupResolution = resolveGroupSessionKey(ctx);
  if (groupResolution) {
    // Group or channel chat - use the resolved key directly
    // groupResolution.key is already in format "{channel}:{type}:{id}"
    return groupResolution.key;
  }

  // Direct chat
  const channel = (
    ctx.Provider?.trim() ||
    ctx.Surface?.trim() ||
    ctx.OriginatingChannel?.toString().trim() ||
    ""
  ).toLowerCase();
  if (!channel) {
    return null;
  }

  const from = (ctx.From?.trim() || "").toLowerCase();
  if (!from) {
    return null;
  }
  return `${channel}:direct:${from}`;
}

/**
 * Check if a conversation matches any sessionLinks group.
 * Returns the link group name if matched, null otherwise.
 */
function resolveSessionLink(
  conversationId: string,
  sessionLinks?: Record<string, string[]>,
): string | null {
  if (!sessionLinks || !conversationId) {
    return null;
  }
  const normalized = conversationId.toLowerCase();
  for (const [linkName, ids] of Object.entries(sessionLinks)) {
    if (!Array.isArray(ids)) {
      continue;
    }
    for (const id of ids) {
      if (id.toLowerCase() === normalized) {
        return linkName;
      }
    }
  }
  return null;
}

/**
 * Resolve the session key with a canonical direct-chat bucket (default: "main").
 * All non-group direct chats collapse to this bucket; groups stay isolated.
 * If sessionLinks is provided and the conversation matches a link group,
 * the linked session key is returned instead.
 */
export function resolveSessionKey(
  scope: SessionScope,
  ctx: MsgContext,
  options?: string | ResolveSessionKeyOptions,
) {
  // Support legacy signature: resolveSessionKey(scope, ctx, mainKey)
  const opts: ResolveSessionKeyOptions =
    typeof options === "string" ? { mainKey: options } : (options ?? {});

  const explicit = ctx.SessionKey?.trim();
  if (explicit) {
    return explicit.toLowerCase();
  }

  // Check sessionLinks first
  if (opts.sessionLinks) {
    const conversationId = buildConversationId(ctx);
    if (conversationId) {
      const linkName = resolveSessionLink(conversationId, opts.sessionLinks);
      if (linkName) {
        return `agent:${DEFAULT_AGENT_ID}:linked:${linkName.toLowerCase()}`;
      }
    }
  }

  const raw = deriveSessionKey(scope, ctx);
  if (scope === "global") {
    return raw;
  }
  const canonicalMainKey = normalizeMainKey(opts.mainKey);
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
