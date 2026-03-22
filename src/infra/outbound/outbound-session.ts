import type { ChatType } from "../../channels/chat-type.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { recordSessionMetaFromInbound, resolveStorePath } from "../../config/sessions.js";
import { buildAgentSessionKey, type RoutePeer } from "../../routing/resolve-route.js";
import { parseTelegramTarget, resolveTelegramTargetChatType } from "../../telegram/targets.js";
import type { MsgContext } from "../../auto-reply/templating.js";

export type OutboundSessionRoute = {
  sessionKey: string;
  baseSessionKey: string;
  peer: RoutePeer;
  chatType: "direct" | "group" | "channel";
  from: string;
  to: string;
  threadId?: string | number;
};

export type ResolveOutboundSessionRouteParams = {
  cfg: OpenClawConfig;
  channel: ChannelId;
  agentId: string;
  accountId?: string | null;
  target: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  resolvedTarget?: { kind?: "user" | "channel" | "group" };
};

function normalizeThreadId(value?: string | number | null): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return undefined;
    }
    return String(Math.trunc(value));
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function stripProviderPrefix(raw: string, channel: string): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  const prefix = `${channel.toLowerCase()}:`;
  if (lower.startsWith(prefix)) {
    return trimmed.slice(prefix.length).trim();
  }
  return trimmed;
}

function stripKindPrefix(raw: string): string {
  return raw.replace(/^(user|channel|group|conversation|room|dm):/i, "").trim();
}

function inferPeerKind(params: {
  channel: ChannelId;
  resolvedTarget?: { kind?: "user" | "channel" | "group" };
}): ChatType {
  const resolvedKind = params.resolvedTarget?.kind;
  if (resolvedKind === "user") {
    return "direct";
  }
  if (resolvedKind === "channel") {
    return "channel";
  }
  if (resolvedKind === "group") {
    return "group";
  }
  return "direct";
}

function buildBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: ChannelId;
  accountId?: string | null;
  peer: RoutePeer;
}): string {
  const { cfg, agentId, channel, accountId, peer } = params;
  const accountKey = accountId ? `:${accountId}` : "";
  return `${channel}${accountKey}:${peer.id}`;
}

function resolveTelegramSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const parsed = parseTelegramTarget(params.target);
  const chatId = parsed.chatId.trim();
  if (!chatId) {
    return null;
  }
  const fallbackThreadId = normalizeThreadId(params.threadId);
  const resolvedThreadId = parsed.messageThreadId ?? fallbackThreadId;
  const chatType = resolveTelegramTargetChatType(params.target);
  const isGroup =
    chatType === "group" ||
    (chatType === "unknown" &&
      params.resolvedTarget?.kind &&
      params.resolvedTarget.kind !== "user");
  const peerId =
    isGroup && resolvedThreadId ? `${chatId}:topic:${resolvedThreadId}` : chatId;
  const peer: RoutePeer = {
    kind: isGroup ? "group" : "direct",
    id: peerId,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "telegram",
    accountId: params.accountId,
    peer,
  });
  const threadKeys =
    resolvedThreadId && !isGroup
      ? { sessionKey: `${baseSessionKey}:thread:${resolvedThreadId}` }
      : null;
  return {
    sessionKey: threadKeys?.sessionKey ?? baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? "group" : "direct",
    from: isGroup
      ? `telegram:group:${peerId}`
      : `telegram:${peerId}`,
    to: chatId,
    threadId: resolvedThreadId,
  };
}

function resolveFeishuSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  let trimmed = stripProviderPrefix(params.target, "feishu");
  trimmed = stripProviderPrefix(trimmed, "lark").trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  let isGroup = false;
  let typeExplicit = false;

  if (lower.startsWith("group:") || lower.startsWith("chat:")) {
    trimmed = trimmed.replace(/^(group|chat):/i, "").trim();
    isGroup = true;
    typeExplicit = true;
  } else if (lower.startsWith("user:") || lower.startsWith("dm:")) {
    trimmed = trimmed.replace(/^(user|dm):/i, "").trim();
    isGroup = false;
    typeExplicit = true;
  }

  const idLower = trimmed.toLowerCase();
  if (!typeExplicit) {
    if (idLower.startsWith("ou_") || idLower.startsWith("on_")) {
      isGroup = false;
    }
  }

  const peer: RoutePeer = {
    kind: isGroup ? "group" : "direct",
    id: trimmed,
  };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "feishu",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `feishu:group:${trimmed}` : `feishu:${trimmed}`,
    to: trimmed,
  };
}

function resolveFallbackSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const trimmed = stripProviderPrefix(params.target, params.channel).trim();
  if (!trimmed) {
    return null;
  }
  const peerKind = inferPeerKind({
    channel: params.channel,
    resolvedTarget: params.resolvedTarget,
  });
  const peerId = stripKindPrefix(trimmed);
  if (!peerId) {
    return null;
  }
  const peer: RoutePeer = { kind: peerKind, id: peerId };
  const baseSessionKey = buildBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    peer,
  });
  const chatType = peerKind === "direct" ? "direct" : peerKind === "channel" ? "channel" : "group";
  const from =
    peerKind === "direct"
      ? `${params.channel}:${peerId}`
      : `${params.channel}:${peerKind}:${peerId}`;
  const toPrefix = peerKind === "direct" ? "user" : "channel";
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType,
    from,
    to: `${toPrefix}:${peerId}`,
  };
}

type OutboundSessionResolver = (
  params: ResolveOutboundSessionRouteParams,
) => OutboundSessionRoute | null | Promise<OutboundSessionRoute | null>;

const OUTBOUND_SESSION_RESOLVERS: Partial<Record<ChannelId, OutboundSessionResolver>> = {
  telegram: resolveTelegramSession,
  feishu: resolveFeishuSession,
};

export async function resolveOutboundSessionRoute(
  params: ResolveOutboundSessionRouteParams,
): Promise<OutboundSessionRoute | null> {
  const target = params.target.trim();
  if (!target) {
    return null;
  }
  const nextParams = { ...params, target };
  const resolver = OUTBOUND_SESSION_RESOLVERS[params.channel];
  if (!resolver) {
    return resolveFallbackSession(nextParams);
  }
  return await resolver(nextParams);
}

export async function ensureOutboundSessionEntry(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: ChannelId;
  accountId?: string | null;
  route: OutboundSessionRoute;
}): Promise<void> {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const ctx: MsgContext = {
    From: params.route.from,
    To: params.route.to,
    SessionKey: params.route.sessionKey,
    AccountId: params.accountId ?? undefined,
    ChatType: params.route.chatType,
    Provider: params.channel,
    Surface: params.channel,
    MessageThreadId: params.route.threadId,
    OriginatingChannel: params.channel,
    OriginatingTo: params.route.to,
  };
  try {
    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: params.route.sessionKey,
      ctx,
    });
  } catch (error) {
    // Session entry creation is best-effort
  }
}
