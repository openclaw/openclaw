import { resolveChannelAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { OpenClawConfig } from "./config.js";
import type { ChannelImplicitMentionsConfig } from "./types.channels.js";

export type ResolvedChannelImplicitMentions = Required<ChannelImplicitMentionsConfig>;

type ChannelImplicitMentionsSource = {
  implicitMentions?: ChannelImplicitMentionsConfig;
  accounts?: Record<string, { implicitMentions?: ChannelImplicitMentionsConfig }>;
};

const SHIPPED_IMPLICIT_MENTION_DEFAULTS: ResolvedChannelImplicitMentions = {
  replyToBot: true,
  quotedBot: true,
  threadParticipation: true,
};

/** Resolves each implicit-mention kind using account, channel, defaults, then shipped behavior. */
export function resolveChannelImplicitMentions(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
}): ResolvedChannelImplicitMentions {
  const channelConfig = params.cfg.channels?.[params.channel] as
    | ChannelImplicitMentionsSource
    | undefined;
  const accountConfig = resolveChannelAccountEntry(
    channelConfig?.accounts,
    normalizeAccountId(params.accountId),
    params.channel,
  );
  const defaults = params.cfg.channels?.defaults?.implicitMentions;
  const resolve = (kind: keyof ResolvedChannelImplicitMentions) =>
    accountConfig?.implicitMentions?.[kind] ??
    channelConfig?.implicitMentions?.[kind] ??
    defaults?.[kind] ??
    SHIPPED_IMPLICIT_MENTION_DEFAULTS[kind];
  return {
    replyToBot: resolve("replyToBot"),
    quotedBot: resolve("quotedBot"),
    threadParticipation: resolve("threadParticipation"),
  };
}
