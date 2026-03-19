import { logVerbose } from "../../globals.js";

type FeishuConversationParams = {
  ctx: {
    MessageThreadId?: string | number | null;
    ChatType?: string;
    OriginatingTo?: string;
    To?: string;
  };
  command: {
    to?: string;
  };
};

function normalizeFeishuTarget(raw: string): string | null {
  let trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  // Strip provider prefixes (feishu: / lark:) before target-type prefixes.
  const providerMatch = /^(feishu|lark):/i.exec(trimmed);
  if (providerMatch) {
    trimmed = trimmed.slice(providerMatch[0].length).trim();
    if (!trimmed) {
      return null;
    }
  }
  const lowered = trimmed.toLowerCase();
  // Strip common Feishu target prefixes to get the raw ID.
  for (const prefix of ["chat:", "group:", "channel:", "user:", "dm:", "open_id:"]) {
    if (lowered.startsWith(prefix)) {
      const id = trimmed.slice(prefix.length).trim();
      return id || null;
    }
  }
  return trimmed;
}

export function resolveFeishuConversationId(params: FeishuConversationParams): string | undefined {
  const rawThreadId =
    params.ctx.MessageThreadId != null ? String(params.ctx.MessageThreadId).trim() : "";
  const threadId = rawThreadId || undefined;
  const toCandidates = [
    typeof params.ctx.OriginatingTo === "string" ? params.ctx.OriginatingTo : "",
    typeof params.command.to === "string" ? params.command.to : "",
    typeof params.ctx.To === "string" ? params.ctx.To : "",
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  const chatId = toCandidates
    .map((candidate) => normalizeFeishuTarget(candidate))
    .find((candidate) => candidate != null && candidate.length > 0);
  if (!chatId) {
    return undefined;
  }
  if (threadId) {
    return `${chatId}:topic:${threadId}`;
  }
  // Direct messages are always focusable. Use ChatType when available, otherwise
  // infer from the target prefix: user:ou_* targets are DMs, chat:oc_* are groups.
  const chatType =
    typeof params.ctx.ChatType === "string" ? params.ctx.ChatType.trim().toLowerCase() : "";
  if (chatType === "direct" || chatType === "p2p" || chatType === "private") {
    return chatId;
  }
  // Group chats (oc_ prefix) without a topic should not become globally focused.
  if (chatType === "group" || chatId.toLowerCase().startsWith("oc_")) {
    return undefined;
  }
  // For unrecognised ChatType, only allow known DM identifiers (ou_ prefix).
  // Unknown or future chat types default to non-focusable to avoid accidentally
  // binding group-like conversations.
  if (chatId.toLowerCase().startsWith("ou_")) {
    return chatId;
  }
  logVerbose(
    `resolveFeishuConversationId: rejecting unknown chatType=${chatType || "(empty)"} chatId prefix=${chatId.slice(0, 3)}`,
  );
  return undefined;
}

/**
 * Check whether a Feishu topic conversation uses sender-scoped IDs based on
 * the channel config. Only `group_topic_sender` scope appends
 * `:sender:<openId>` to the conversation ID during inbound routing.
 */
export function isFeishuSenderScopedTopic(params: {
  cfg: { channels?: Record<string, unknown> };
  conversationId: string;
}): boolean {
  if (!params.conversationId.includes(":topic:")) {
    return false;
  }
  const feishuCfg = params.cfg.channels?.feishu as Record<string, unknown> | undefined;
  if (!feishuCfg) {
    return false;
  }
  const chatId = params.conversationId.split(":topic:")[0];
  // Resolve per-group config (exact match, case-insensitive, or wildcard).
  const groups = feishuCfg.groups as Record<string, Record<string, unknown>> | undefined;
  let groupConfig: Record<string, unknown> | undefined;
  if (groups && chatId) {
    groupConfig = groups[chatId];
    if (!groupConfig) {
      const lowered = chatId.toLowerCase();
      const matchKey = Object.keys(groups).find((key) => key.toLowerCase() === lowered);
      groupConfig = matchKey ? groups[matchKey] : groups["*"];
    }
  }
  const scope =
    (groupConfig?.groupSessionScope as string) ?? (feishuCfg.groupSessionScope as string);
  return scope === "group_topic_sender";
}
