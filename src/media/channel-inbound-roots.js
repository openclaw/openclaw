import { loadBundledPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
const mediaContractApiByResolver = new Map();
function mediaContractCacheKey(channelId, resolver) {
    return `${channelId}:${resolver}`;
}
function loadChannelMediaContractApi(channelId, resolver) {
    const cacheKey = mediaContractCacheKey(channelId, resolver);
    if (mediaContractApiByResolver.has(cacheKey)) {
        return mediaContractApiByResolver.get(cacheKey) ?? undefined;
    }
    try {
        const loaded = loadBundledPluginPublicArtifactModuleSync({
            dirName: channelId,
            artifactBasename: "media-contract-api.js",
        });
        if (typeof loaded[resolver] === "function") {
            mediaContractApiByResolver.set(cacheKey, loaded);
            return loaded;
        }
    }
    catch (error) {
        if (!(error instanceof Error &&
            error.message.startsWith("Unable to resolve bundled plugin public surface "))) {
            throw error;
        }
    }
    mediaContractApiByResolver.set(cacheKey, null);
    return undefined;
}
function findChannelMediaContractApi(channelId, resolver) {
    const normalized = normalizeOptionalLowercaseString(channelId);
    if (!normalized) {
        return undefined;
    }
    return loadChannelMediaContractApi(normalized, resolver);
}
export function resolveChannelInboundAttachmentRoots(params) {
    const contractApi = findChannelMediaContractApi(params.ctx.Surface ?? params.ctx.Provider, "resolveInboundAttachmentRoots");
    if (contractApi?.resolveInboundAttachmentRoots) {
        return contractApi.resolveInboundAttachmentRoots({
            cfg: params.cfg,
            accountId: params.ctx.AccountId,
        });
    }
    return undefined;
}
export function resolveChannelRemoteInboundAttachmentRoots(params) {
    const contractApi = findChannelMediaContractApi(params.ctx.Surface ?? params.ctx.Provider, "resolveRemoteInboundAttachmentRoots");
    if (contractApi?.resolveRemoteInboundAttachmentRoots) {
        return contractApi.resolveRemoteInboundAttachmentRoots({
            cfg: params.cfg,
            accountId: params.ctx.AccountId,
        });
    }
    return undefined;
}
