import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";

type ChannelMediaContractApi = {
  /** Local host roots where a channel stores downloaded inbound attachments. */
  resolveInboundAttachmentRoots?: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
  }) => readonly string[] | undefined;
  /** Remote/guest-visible roots used when staging channel inbound attachments into sandboxes. */
  resolveRemoteInboundAttachmentRoots?: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
  }) => readonly string[] | undefined;
};
type ChannelMediaRootResolver = keyof ChannelMediaContractApi;

const mediaContractApiByChannel = new Map<string, ChannelMediaContractApi | null>();

function loadChannelMediaContractApi(
  channelId: string,
  resolver: ChannelMediaRootResolver,
): ChannelMediaContractApi | undefined {
  if (mediaContractApiByChannel.has(channelId)) {
    const cached = mediaContractApiByChannel.get(channelId);
    return cached && typeof cached[resolver] === "function" ? cached : undefined;
  }

  try {
    // Media roots are a hot path during inbound staging; load the narrow media contract artifact
    // instead of bootstrapping the full channel plugin or broad contract API.
    const loaded = loadBundledPluginPublicArtifactModuleSync<ChannelMediaContractApi>({
      dirName: channelId,
      artifactBasename: "media-contract-api.js",
    });
    mediaContractApiByChannel.set(channelId, loaded);
    if (typeof loaded[resolver] === "function") {
      return loaded;
    }
    return undefined;
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      )
    ) {
      throw error;
    }
  }

  mediaContractApiByChannel.set(channelId, null);
  return undefined;
}

function findChannelMediaContractApi(
  channelId: string | null | undefined,
  resolver: ChannelMediaRootResolver,
) {
  const normalized = normalizeOptionalLowercaseString(channelId);
  if (!normalized) {
    return undefined;
  }
  return loadChannelMediaContractApi(normalized, resolver);
}

export function resolveChannelInboundAttachmentRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] | undefined {
  return resolveChannelInboundAttachmentRootsForChannel({
    cfg: params.cfg,
    channelId: params.ctx.Surface ?? params.ctx.Provider,
    accountId: params.ctx.AccountId,
  });
}

/** Resolves local inbound attachment roots when only channel/account ids are available. */
export function resolveChannelInboundAttachmentRootsForChannel(params: {
  cfg: OpenClawConfig;
  channelId?: string | null;
  accountId?: string | null;
}): readonly string[] | undefined {
  const contractApi = findChannelMediaContractApi(
    params.channelId,
    "resolveInboundAttachmentRoots",
  );
  if (contractApi?.resolveInboundAttachmentRoots) {
    return contractApi.resolveInboundAttachmentRoots({
      cfg: params.cfg,
      accountId: params.accountId ?? undefined,
    });
  }
  return undefined;
}

/** Resolves sandbox/remote inbound attachment roots from the channel media contract artifact. */
export function resolveChannelRemoteInboundAttachmentRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] | undefined {
  const contractApi = findChannelMediaContractApi(
    params.ctx.Surface ?? params.ctx.Provider,
    "resolveRemoteInboundAttachmentRoots",
  );
  if (contractApi?.resolveRemoteInboundAttachmentRoots) {
    return contractApi.resolveRemoteInboundAttachmentRoots({
      cfg: params.cfg,
      accountId: params.ctx.AccountId,
    });
  }
  return undefined;
}
