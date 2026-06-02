import type { ReplyToMode } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelThreadingAdapter } from "./types.core.js";

type ReplyToModeResolver = NonNullable<ChannelThreadingAdapter["resolveReplyToMode"]>;

/** Creates a reply-mode resolver for channels with one fixed threading mode. */
export function createStaticReplyToModeResolver(mode: ReplyToMode): ReplyToModeResolver {
  return () => mode;
}

/**
 * Reads reply mode from the channel's top-level config object, defaulting to
 * `off` for channels that have no threading preference configured.
 */
export function createTopLevelChannelReplyToModeResolver(channelId: string): ReplyToModeResolver {
  return ({ cfg }) => {
    const channelConfig = (
      cfg.channels as Record<string, { replyToMode?: ReplyToMode }> | undefined
    )?.[channelId];
    return channelConfig?.replyToMode ?? "off";
  };
}

/**
 * Creates a reply-mode resolver for channels whose threading mode depends on
 * account settings and optionally on the current chat type.
 */
export function createScopedAccountReplyToModeResolver<TAccount>(params: {
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => TAccount;
  resolveReplyToMode: (
    account: TAccount,
    chatType?: string | null,
  ) => ReplyToMode | null | undefined;
  fallback?: ReplyToMode;
}): ReplyToModeResolver {
  return ({ cfg, accountId, chatType }) =>
    params.resolveReplyToMode(params.resolveAccount(cfg, accountId), chatType) ??
    params.fallback ??
    "off";
}
