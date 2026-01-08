import type {
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
