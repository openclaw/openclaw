import type {
  GroupPolicy,
  MSTeamsChannelConfig,
  MSTeamsConfig,
  MSTeamsReplyStyle,
  MSTeamsTeamConfig,
} from "../config/types.js";

export type MSTeamsResolvedRouteConfig = {
  teamConfig?: MSTeamsTeamConfig;
  channelConfig?: MSTeamsChannelConfig;
};

export function resolveMSTeamsRouteConfig(params: {
  cfg?: MSTeamsConfig;
  teamId?: string | null | undefined;
  conversationId?: string | null | undefined;
}): MSTeamsResolvedRouteConfig {
  const teamId = params.teamId?.trim();
  const conversationId = params.conversationId?.trim();
  const teamConfig = teamId ? params.cfg?.teams?.[teamId] : undefined;
  const channelConfig =
    teamConfig && conversationId
      ? teamConfig.channels?.[conversationId]
      : undefined;
  return { teamConfig, channelConfig };
}

export type MSTeamsReplyPolicy = {
  requireMention: boolean;
  replyStyle: MSTeamsReplyStyle;
};

export function resolveMSTeamsReplyPolicy(params: {
  isDirectMessage: boolean;
  globalConfig?: MSTeamsConfig;
  teamConfig?: MSTeamsTeamConfig;
  channelConfig?: MSTeamsChannelConfig;
}): MSTeamsReplyPolicy {
  if (params.isDirectMessage) {
    return { requireMention: false, replyStyle: "thread" };
  }

  const requireMention =
    params.channelConfig?.requireMention ??
    params.teamConfig?.requireMention ??
    params.globalConfig?.requireMention ??
    true;

  const explicitReplyStyle =
    params.channelConfig?.replyStyle ??
    params.teamConfig?.replyStyle ??
    params.globalConfig?.replyStyle;

  const replyStyle: MSTeamsReplyStyle =
    explicitReplyStyle ?? (requireMention ? "thread" : "top-level");

  return { requireMention, replyStyle };
}

export function isMSTeamsGroupAllowed(params: {
  groupPolicy: GroupPolicy;
  allowFrom: Array<string | number>;
  senderId: string;
  senderName?: string | null;
}): boolean {
  const { groupPolicy } = params;
  if (groupPolicy === "disabled") return false;
  if (groupPolicy === "open") return true;
  const allowFrom = params.allowFrom
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean);
  if (allowFrom.length === 0) return false;
  if (allowFrom.includes("*")) return true;
  const senderId = params.senderId.toLowerCase();
  const senderName = params.senderName?.toLowerCase();
  return (
    allowFrom.includes(senderId) ||
    (senderName ? allowFrom.includes(senderName) : false)
  );
}
