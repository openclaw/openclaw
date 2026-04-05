import type { MsgContext } from "../auto-reply/templating.js";
import { getBootstrapChannelPlugin } from "../channels/plugins/bootstrap-registry.js";
import type { MullusiConfig } from "../config/config.js";

function normalizeChannelId(value?: string | null): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function findChannelMessagingAdapter(channelId?: string | null) {
  const normalized = normalizeChannelId(channelId);
  if (!normalized) {
    return undefined;
  }
  return getBootstrapChannelPlugin(normalized)?.messaging;
}

export function resolveChannelInboundAttachmentRoots(params: {
  cfg: MullusiConfig;
  ctx: MsgContext;
}): readonly string[] | undefined {
  const messaging = findChannelMessagingAdapter(params.ctx.Surface ?? params.ctx.Provider);
  return messaging?.resolveInboundAttachmentRoots?.({
    cfg: params.cfg,
    accountId: params.ctx.AccountId,
  });
}

export function resolveChannelRemoteInboundAttachmentRoots(params: {
  cfg: MullusiConfig;
  ctx: MsgContext;
}): readonly string[] | undefined {
  const messaging = findChannelMessagingAdapter(params.ctx.Surface ?? params.ctx.Provider);
  return messaging?.resolveRemoteInboundAttachmentRoots?.({
    cfg: params.cfg,
    accountId: params.ctx.AccountId,
  });
}
