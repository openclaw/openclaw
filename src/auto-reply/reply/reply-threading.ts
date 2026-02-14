import type { OpenClawConfig } from "../../config/config.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { getChannelDock } from "../../channels/dock.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";

export function resolveReplyToMode(
  cfg: OpenClawConfig,
  channel?: OriginatingChannelType,
  accountId?: string | null,
  chatType?: string | null,
): ReplyToMode {
  const provider = normalizeChannelId(channel);
  if (!provider) {
    return "all";
  }
  const resolved = getChannelDock(provider)?.threading?.resolveReplyToMode?.({
    cfg,
    accountId,
    chatType,
  });
  return resolved ?? "all";
}

export function createReplyToModeFilter(
  mode: ReplyToMode,
  opts: { allowTagsWhenOff?: boolean } = {},
) {
  let hasThreaded = false;
  return (payload: ReplyPayload): ReplyPayload => {
    if (!payload.replyToId) {
      return payload;
    }
    if (mode === "off") {
      if (opts.allowTagsWhenOff && payload.replyToTag) {
        return payload;
      }
      return { ...payload, replyToId: undefined };
    }
    if (mode === "all") {
      return payload;
    }
    if (hasThreaded) {
      return { ...payload, replyToId: undefined };
    }
    hasThreaded = true;
    return payload;
  };
}

export function createReplyToModeFilterForChannel(
  mode: ReplyToMode,
  channel?: OriginatingChannelType,
) {
  const provider = normalizeChannelId(channel);
  // Always honour explicit [[reply_to_*]] tags even when replyToMode is "off".
  // Per-channel opt-out is possible but the safe default is to allow them.
  const allowTagsWhenOff = provider
    ? (getChannelDock(provider)?.threading?.allowTagsWhenOff ?? true)
    : true;
  return createReplyToModeFilter(mode, {
    allowTagsWhenOff,
  });
}
