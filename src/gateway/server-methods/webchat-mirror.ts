import { markInboundMessageAsSeen } from "../../auto-reply/reply/inbound-dedupe.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver-runtime.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  deliveryContextFromSession,
  type DeliveryContextSessionSource,
} from "../../utils/delivery-context.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isWebchatClient,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";

const CHANNEL_AGNOSTIC_SESSION_SCOPES = new Set([
  "main",
  "direct",
  "dm",
  "group",
  "channel",
  "cron",
  "run",
  "subagent",
  "acp",
  "thread",
  "topic",
]);

const CHANNEL_SCOPED_SESSION_SHAPES = new Set(["direct", "dm", "group", "channel"]);

type GatewayClientInfoLike = {
  mode?: string | null;
  id?: string | null;
};

export type WebchatMirrorTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
};

function deriveDiscordUserTargetFromLegacyDmChannel(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  accountId?: string;
  channelId: string;
}): WebchatMirrorTarget | undefined {
  const parsedSession = parseAgentSessionKey(params.sessionKey);
  const agentId = parsedSession?.agentId;
  const storePath = resolveStorePath(params.cfg.session?.store, agentId ? { agentId } : undefined);
  const store = loadSessionStore(storePath);
  const expectedTo = `channel:${params.channelId}`;

  for (const [key, entry] of Object.entries(store)) {
    if (!key.includes(":discord:direct:")) {
      continue;
    }
    const parsedKey = parseAgentSessionKey(key);
    if (!parsedKey || parsedKey.agentId !== agentId) {
      continue;
    }
    const directUserId = parsedKey.rest.split(":").at(-1)?.trim();
    if (!directUserId) {
      continue;
    }
    const route = deliveryContextFromSession(entry);
    const origin = entry.origin;
    const routeAccountId = route?.accountId ?? origin?.accountId ?? entry.lastAccountId;
    const routeTo = route?.to ?? entry.lastTo;
    const originTo = typeof origin?.to === "string" ? origin.to.trim() : undefined;
    if (params.accountId && routeAccountId && routeAccountId !== params.accountId) {
      continue;
    }
    if (routeTo !== expectedTo && originTo !== expectedTo) {
      continue;
    }
    return {
      channel: "discord",
      to: `user:${directUserId}`,
      ...(routeAccountId ? { accountId: routeAccountId } : {}),
      ...(route?.threadId != null ? { threadId: route.threadId } : {}),
    };
  }

  return undefined;
}

function deriveTargetFromSessionKey(sessionKey: string): WebchatMirrorTarget | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  const parts = (parsed?.rest ?? sessionKey).split(":").filter(Boolean);
  const rawChannel = parts[0]?.trim().toLowerCase();
  const channel = normalizeMessageChannel(rawChannel) ?? rawChannel;
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL) {
    return undefined;
  }

  const hasScopedMarkerAt1 = parts[1] && CHANNEL_SCOPED_SESSION_SHAPES.has(parts[1]);
  const hasScopedMarkerAt2 = parts[2] && CHANNEL_SCOPED_SESSION_SHAPES.has(parts[2]);
  const shapeIndex = hasScopedMarkerAt1 ? 1 : hasScopedMarkerAt2 ? 2 : -1;
  const accountId = shapeIndex === 2 ? parts[1] : undefined;
  const shape = shapeIndex >= 0 ? parts[shapeIndex] : undefined;
  const peer = shapeIndex >= 0 ? parts[shapeIndex + 1] : parts[1];
  const threadMarker = shapeIndex >= 0 ? parts[shapeIndex + 2] : parts[2];
  const threadId =
    threadMarker === "thread" || threadMarker === "topic"
      ? shapeIndex >= 0
        ? parts[shapeIndex + 3]
        : parts[3]
      : undefined;

  if (!peer) {
    return undefined;
  }

  let to = peer;
  if (!shape) {
    to = peer.includes(":") ? peer : `${channel}:${peer}`;
  } else if (shape === "channel" || shape === "group") {
    to = `${shape}:${peer}`;
  } else if ((shape === "direct" || shape === "dm") && channel === "discord") {
    to = peer.startsWith("user:") ? peer : `user:${peer}`;
  } else if ((shape === "direct" || shape === "dm") && channel === "telegram") {
    to = `telegram:${peer}`;
  } else if ((shape === "direct" || shape === "dm") && channel === "whatsapp") {
    to = peer.startsWith("whatsapp:") ? peer : `whatsapp:${peer}`;
  }

  return {
    channel,
    to,
    ...(accountId ? { accountId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

export async function mirrorWebchatTextToTarget(params: {
  cfg?: OpenClawConfig;
  sessionKey: string;
  text: string;
  target: WebchatMirrorTarget;
}): Promise<void> {
  const text = params.text.trim();
  if (!text) {
    return;
  }
  const results = await deliverOutboundPayloads({
    cfg: params.cfg ?? loadConfig(),
    channel: params.target.channel,
    to: params.target.to,
    accountId: params.target.accountId,
    threadId: params.target.threadId,
    payloads: [{ text }],
    bestEffort: true,
  });
  for (const result of results) {
    markInboundMessageAsSeen({
      provider: params.target.channel,
      messageId: result.messageId,
      peerId: params.target.to,
      sessionKey: params.sessionKey,
      accountId: params.target.accountId,
      threadId: params.target.threadId,
    });
  }
}

export function resolveWebchatMirrorTarget(params: {
  client?: GatewayClientInfoLike | null;
  entry?: DeliveryContextSessionSource;
  sessionKey: string;
}): WebchatMirrorTarget | undefined {
  if (!isWebchatClient(params.client)) {
    return undefined;
  }

  const route = deliveryContextFromSession(params.entry);
  const cfg = loadConfig();
  const parsedSessionKey = parseAgentSessionKey(params.sessionKey);
  const sessionScopeParts = (parsedSessionKey?.rest ?? params.sessionKey)
    .split(":", 3)
    .filter(Boolean);
  const sessionScopeHead = sessionScopeParts[0];
  const sessionChannelHint =
    normalizeMessageChannel(sessionScopeHead) ?? sessionScopeHead?.trim().toLowerCase();
  const normalizedSessionScopeHead = (sessionScopeHead ?? "").trim().toLowerCase();
  const sessionPeerShapeCandidates = [sessionScopeParts[1], sessionScopeParts[2]]
    .map((part) => (part ?? "").trim().toLowerCase())
    .filter(Boolean);
  const isChannelAgnosticSessionScope = CHANNEL_AGNOSTIC_SESSION_SCOPES.has(
    normalizedSessionScopeHead,
  );
  const isChannelScopedSession = sessionPeerShapeCandidates.some((part) =>
    CHANNEL_SCOPED_SESSION_SHAPES.has(part),
  );
  const hasLegacyChannelPeerShape =
    !isChannelScopedSession &&
    typeof sessionScopeParts[1] === "string" &&
    sessionChannelHint === route?.channel;
  const canMirrorToExternalRoute = Boolean(
    sessionChannelHint &&
    sessionChannelHint !== INTERNAL_MESSAGE_CHANNEL &&
    !isChannelAgnosticSessionScope &&
    (isChannelScopedSession || hasLegacyChannelPeerShape),
  );

  if (!canMirrorToExternalRoute) {
    return undefined;
  }

  const sessionDerivedTarget = deriveTargetFromSessionKey(params.sessionKey);
  const shouldPreferDiscordRouteTarget =
    sessionChannelHint === "discord" &&
    sessionPeerShapeCandidates.includes("channel") &&
    route?.channel === "discord" &&
    typeof route.to === "string" &&
    route.to.startsWith("user:");
  if (shouldPreferDiscordRouteTarget) {
    const routeTo = route?.to;
    if (!routeTo) {
      return undefined;
    }
    return {
      channel: "discord",
      to: routeTo,
      accountId: route?.accountId ?? params.entry?.lastAccountId,
      threadId: route?.threadId ?? params.entry?.lastThreadId,
    };
  }
  const legacyDiscordDmTarget =
    sessionChannelHint === "discord" &&
    sessionPeerShapeCandidates.includes("channel") &&
    typeof sessionDerivedTarget?.to === "string" &&
    sessionDerivedTarget.to.startsWith("channel:")
      ? deriveDiscordUserTargetFromLegacyDmChannel({
          cfg,
          sessionKey: params.sessionKey,
          accountId: params.entry?.lastAccountId ?? route?.accountId,
          channelId: sessionDerivedTarget.to.slice("channel:".length),
        })
      : undefined;
  if (legacyDiscordDmTarget) {
    return legacyDiscordDmTarget;
  }
  if (sessionDerivedTarget) {
    return {
      ...sessionDerivedTarget,
      accountId: sessionDerivedTarget.accountId ?? params.entry?.lastAccountId ?? route?.accountId,
      threadId: sessionDerivedTarget.threadId ?? params.entry?.lastThreadId ?? route?.threadId,
    };
  }

  if (
    !route?.channel ||
    !isDeliverableMessageChannel(route.channel) ||
    route.channel === INTERNAL_MESSAGE_CHANNEL ||
    !route.to
  ) {
    return undefined;
  }

  return {
    channel: route.channel,
    to: route.to,
    accountId: route.accountId,
    threadId: route.threadId,
  };
}
