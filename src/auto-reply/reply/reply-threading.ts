import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";

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
  const resolved = getChannelPlugin(provider)?.threading?.resolveReplyToMode?.({
    cfg,
    accountId,
    chatType,
  });
  return resolved ?? "all";
}

export function createReplyToModeFilter(
  mode: ReplyToMode,
  opts: { allowExplicitReplyTagsWhenOff?: boolean } = {},
) {
  let hasThreaded = false;
  return (payload: ReplyPayload): ReplyPayload => {
    if (!payload.replyToId) {
      return payload;
    }
    if (mode === "off") {
      const isExplicit = Boolean(payload.replyToTag) || Boolean(payload.replyToCurrent);
      // Compaction notices must never be threaded when replyToMode=off — even
      // if they carry explicit reply tags (replyToCurrent).  Honouring the
      // explicit tag here would make status notices appear in-thread while
      // normal assistant replies stay off-thread, contradicting the off-mode
      // expectation.  Strip replyToId unconditionally for compaction payloads.
      if (opts.allowExplicitReplyTagsWhenOff && isExplicit && !payload.isCompactionNotice) {
        return payload;
      }
      return { ...payload, replyToId: undefined };
    }
    if (mode === "all") {
      return payload;
    }
    if (hasThreaded) {
      // Compaction notices are transient status messages that should always
      // appear in-thread, even after the first assistant block has already
      // consumed the "first" slot.  Let them keep their replyToId.
      if (payload.isCompactionNotice) {
        return payload;
      }
      return { ...payload, replyToId: undefined };
    }
    // Compaction notices are transient status messages — they should be
    // threaded (so they appear in-context), but they must not consume the
    // "first" slot of the replyToMode=first filter.  Skip advancing
    // hasThreaded so the real assistant reply still gets replyToId.
    if (!payload.isCompactionNotice) {
      hasThreaded = true;
    }
    return payload;
  };
}

export function createReplyToModeFilterForChannel(
  mode: ReplyToMode,
  channel?: OriginatingChannelType,
) {
  const provider = normalizeChannelId(channel);
  const normalized = typeof channel === "string" ? channel.trim().toLowerCase() : undefined;
  const isWebchat = normalized === "webchat";
  // Default: allow explicit reply tags/directives even when replyToMode is "off".
  // Unknown channels fail closed; internal webchat stays allowed.
  const threading = provider ? getChannelPlugin(provider)?.threading : undefined;
  const allowExplicitReplyTagsWhenOff = provider
    ? (threading?.allowExplicitReplyTagsWhenOff ?? threading?.allowTagsWhenOff ?? true)
    : isWebchat;
  return createReplyToModeFilter(mode, {
    allowExplicitReplyTagsWhenOff,
  });
}
