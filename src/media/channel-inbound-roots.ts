import type { MsgContext } from "../auto-reply/templating.js";
import { getBundledChannelContractSurfaceEntries } from "../channels/plugins/contract-surfaces.js";
import type { OpenClawConfig } from "../config/config.js";

type ChannelInboundMediaRootsSurface = {
  resolveInboundAttachmentRoots?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => string[];
  resolveRemoteInboundAttachmentRoots?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => string[];
};

function normalizeChannelId(value?: string | null): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function findChannelMediaSurface(
  channelId?: string | null,
): ChannelInboundMediaRootsSurface | undefined {
  const normalized = normalizeChannelId(channelId);
  if (!normalized) {
    return undefined;
  }
  return getBundledChannelContractSurfaceEntries().find(
    (entry) => normalizeChannelId(entry.pluginId) === normalized,
  )?.surface as ChannelInboundMediaRootsSurface | undefined;
}

export function resolveChannelInboundAttachmentRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] | undefined {
  const surface = findChannelMediaSurface(params.ctx.Surface ?? params.ctx.Provider);
  return surface?.resolveInboundAttachmentRoots?.({
    cfg: params.cfg,
    accountId: params.ctx.AccountId,
  });
}

export function resolveChannelRemoteInboundAttachmentRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] | undefined {
  const surface = findChannelMediaSurface(params.ctx.Surface ?? params.ctx.Provider);
  return surface?.resolveRemoteInboundAttachmentRoots?.({
    cfg: params.cfg,
    accountId: params.ctx.AccountId,
  });
}
