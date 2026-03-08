import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAgentRoute,
  type ResolvedAgentRoute,
  type RoutePeer,
} from "../../routing/resolve-route.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";

export function buildDiscordRoutePeer(params: {
  isDirectMessage: boolean;
  isGroupDm: boolean;
  directUserId?: string | null;
  conversationId: string;
}): RoutePeer {
  return {
    kind: params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel",
    id: params.isDirectMessage
      ? params.directUserId?.trim() || params.conversationId
      : params.conversationId,
  };
}

export function resolveDiscordConversationRoute(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  guildId?: string | null;
  memberRoleIds?: string[];
  peer: RoutePeer;
  parentConversationId?: string | null;
}): ResolvedAgentRoute {
  return resolveAgentRoute({
    cfg: params.cfg,
    channel: "discord",
    accountId: params.accountId,
    guildId: params.guildId ?? undefined,
    memberRoleIds: params.memberRoleIds,
    peer: params.peer,
    parentPeer: params.parentConversationId
      ? { kind: "channel", id: params.parentConversationId }
      : undefined,
  });
}

export function resolveDiscordEffectiveRoute(params: {
  route: ResolvedAgentRoute;
  boundSessionKey?: string | null;
  configuredRoute?: { route: ResolvedAgentRoute } | null;
  matchedBy?: ResolvedAgentRoute["matchedBy"];
}): ResolvedAgentRoute {
  const boundSessionKey = params.boundSessionKey?.trim();
  if (!boundSessionKey) {
    return params.configuredRoute?.route ?? params.route;
  }
  return {
    ...params.route,
    sessionKey: boundSessionKey,
    agentId: resolveAgentIdFromSessionKey(boundSessionKey),
    ...(params.matchedBy ? { matchedBy: params.matchedBy } : {}),
  };
}
