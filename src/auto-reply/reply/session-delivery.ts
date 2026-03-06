import type { SessionEntry } from "../../config/sessions.js";
import { buildAgentMainSessionKey } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  deliveryContextFromSession,
  deliveryContextKey,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import type { MsgContext } from "../templating.js";

export type LegacyMainDeliveryRetirement = {
  key: string;
  entry: SessionEntry;
};

function resolveSessionKeyChannelHint(sessionKey?: string): string | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return undefined;
  }
  const head = parsed.rest.split(":")[0]?.trim().toLowerCase();
  if (!head || head === "main" || head === "cron" || head === "subagent" || head === "acp") {
    return undefined;
  }
  return normalizeMessageChannel(head);
}

function isMainSessionKey(sessionKey?: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return (sessionKey ?? "").trim().toLowerCase() === "main";
  }
  return parsed.rest.trim().toLowerCase() === "main";
}

const DIRECT_SESSION_MARKERS = new Set(["direct", "dm"]);
const THREAD_SESSION_MARKERS = new Set(["thread", "topic"]);

function hasStrictDirectSessionTail(parts: string[], markerIndex: number): boolean {
  const peerId = parts[markerIndex + 1]?.trim();
  if (!peerId) {
    return false;
  }
  const tail = parts.slice(markerIndex + 2);
  if (tail.length === 0) {
    return true;
  }
  return tail.length === 2 && THREAD_SESSION_MARKERS.has(tail[0] ?? "") && Boolean(tail[1]?.trim());
}

function isDirectSessionKey(sessionKey?: string): boolean {
  const raw = (sessionKey ?? "").trim().toLowerCase();
  if (!raw) {
    return false;
  }
  const scoped = parseAgentSessionKey(raw)?.rest ?? raw;
  const parts = scoped.split(":").filter(Boolean);
  if (parts.length < 2) {
    return false;
  }
  if (DIRECT_SESSION_MARKERS.has(parts[0] ?? "")) {
    return hasStrictDirectSessionTail(parts, 0);
  }
  const channel = normalizeMessageChannel(parts[0]);
  if (!channel || !isDeliverableMessageChannel(channel)) {
    return false;
  }
  if (DIRECT_SESSION_MARKERS.has(parts[1] ?? "")) {
    return hasStrictDirectSessionTail(parts, 1);
  }
  return Boolean(parts[1]?.trim()) && DIRECT_SESSION_MARKERS.has(parts[2] ?? "")
    ? hasStrictDirectSessionTail(parts, 2)
    : false;
}

function isExternalRoutingChannel(channel?: string): channel is string {
  return Boolean(
    channel && channel !== INTERNAL_MESSAGE_CHANNEL && isDeliverableMessageChannel(channel),
  );
}

export function resolveLastChannelRaw(params: {
  originatingChannelRaw?: string;
  persistedLastChannel?: string;
  sessionKey?: string;
}): string | undefined {
  const originatingChannel = normalizeMessageChannel(params.originatingChannelRaw);
  // WebChat should own reply routing for direct-session UI turns, even when the
  // session previously replied through an external channel like iMessage.
  if (
    originatingChannel === INTERNAL_MESSAGE_CHANNEL &&
    (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))
  ) {
    return params.originatingChannelRaw;
  }
  const persistedChannel = normalizeMessageChannel(params.persistedLastChannel);
  const sessionKeyChannelHint = resolveSessionKeyChannelHint(params.sessionKey);
  let resolved = params.originatingChannelRaw || params.persistedLastChannel;
  // Internal/non-deliverable sources should not overwrite previously known
  // external delivery routes (or explicit channel hints from the session key).
  if (!isExternalRoutingChannel(originatingChannel)) {
    if (isExternalRoutingChannel(persistedChannel)) {
      resolved = persistedChannel;
    } else if (isExternalRoutingChannel(sessionKeyChannelHint)) {
      resolved = sessionKeyChannelHint;
    }
  }
  return resolved;
}

export function resolveLastToRaw(params: {
  originatingChannelRaw?: string;
  originatingToRaw?: string;
  toRaw?: string;
  persistedLastTo?: string;
  persistedLastChannel?: string;
  sessionKey?: string;
}): string | undefined {
  const originatingChannel = normalizeMessageChannel(params.originatingChannelRaw);
  if (
    originatingChannel === INTERNAL_MESSAGE_CHANNEL &&
    (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))
  ) {
    return params.originatingToRaw || params.toRaw;
  }
  const persistedChannel = normalizeMessageChannel(params.persistedLastChannel);
  const sessionKeyChannelHint = resolveSessionKeyChannelHint(params.sessionKey);

  // When the turn originates from an internal/non-deliverable source, do not
  // replace an established external destination with internal routing ids
  // (e.g., session/webchat ids).
  if (!isExternalRoutingChannel(originatingChannel)) {
    const hasExternalFallback =
      isExternalRoutingChannel(persistedChannel) || isExternalRoutingChannel(sessionKeyChannelHint);
    if (hasExternalFallback && params.persistedLastTo) {
      return params.persistedLastTo;
    }
  }

  return params.originatingToRaw || params.toRaw || params.persistedLastTo;
}

export function maybeRetireLegacyMainDeliveryRoute(params: {
  sessionCfg: { dmScope?: string } | undefined;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  agentId: string;
  mainKey: string;
  isGroup: boolean;
  ctx: MsgContext;
}): LegacyMainDeliveryRetirement | undefined {
  const dmScope = params.sessionCfg?.dmScope ?? "main";
  if (dmScope === "main" || params.isGroup) {
    return undefined;
  }
  const canonicalMainSessionKey = buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: params.mainKey,
  }).toLowerCase();
  if (params.sessionKey === canonicalMainSessionKey) {
    return undefined;
  }
  const legacyMain = params.sessionStore[canonicalMainSessionKey];
  if (!legacyMain) {
    return undefined;
  }
  const legacyRouteKey = deliveryContextKey(deliveryContextFromSession(legacyMain));
  if (!legacyRouteKey) {
    return undefined;
  }
  const activeDirectRouteKey = deliveryContextKey(
    normalizeDeliveryContext({
      channel: params.ctx.OriginatingChannel as string | undefined,
      to: params.ctx.OriginatingTo || params.ctx.To,
      accountId: params.ctx.AccountId,
      threadId: params.ctx.MessageThreadId,
    }),
  );
  if (!activeDirectRouteKey || activeDirectRouteKey !== legacyRouteKey) {
    return undefined;
  }
  if (
    legacyMain.deliveryContext === undefined &&
    legacyMain.lastChannel === undefined &&
    legacyMain.lastTo === undefined &&
    legacyMain.lastAccountId === undefined &&
    legacyMain.lastThreadId === undefined
  ) {
    return undefined;
  }
  return {
    key: canonicalMainSessionKey,
    entry: {
      ...legacyMain,
      deliveryContext: undefined,
      lastChannel: undefined,
      lastTo: undefined,
      lastAccountId: undefined,
      lastThreadId: undefined,
    },
  };
}
