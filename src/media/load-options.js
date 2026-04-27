export function resolveOutboundMediaLocalRoots(mediaLocalRoots) {
    if (mediaLocalRoots === "any") {
        return mediaLocalRoots;
    }
    return mediaLocalRoots && mediaLocalRoots.length > 0 ? mediaLocalRoots : undefined;
}
export function resolveOutboundMediaAccess(params = {}) {
    const resolvedLocalRoots = resolveOutboundMediaLocalRoots(params.mediaAccess?.localRoots ?? params.mediaLocalRoots);
    const localRoots = resolvedLocalRoots === "any" ? undefined : resolvedLocalRoots;
    const readFile = params.mediaAccess?.readFile ?? params.mediaReadFile;
    const workspaceDir = params.mediaAccess?.workspaceDir;
    if (!localRoots && !readFile && !workspaceDir) {
        return undefined;
    }
    return {
        ...(localRoots ? { localRoots } : {}),
        ...(readFile ? { readFile } : {}),
        ...(workspaceDir ? { workspaceDir } : {}),
    };
}
export function buildOutboundMediaLoadOptions(params = {}) {
    const explicitLocalRoots = resolveOutboundMediaLocalRoots(params.mediaLocalRoots);
    const mediaAccess = resolveOutboundMediaAccess({
        mediaAccess: params.mediaAccess,
        mediaLocalRoots: explicitLocalRoots === "any" ? undefined : explicitLocalRoots,
        mediaReadFile: params.mediaAccess?.readFile ? undefined : params.mediaReadFile,
    });
    const workspaceDir = mediaAccess?.workspaceDir ?? params.workspaceDir;
    const readFile = mediaAccess?.readFile ?? params.mediaReadFile;
    const localRoots = mediaAccess?.localRoots ?? explicitLocalRoots;
    if (readFile) {
        if (!localRoots) {
            throw new Error('Host media read requires explicit localRoots. Pass mediaAccess.localRoots or opt in with localRoots: "any".');
        }
        return {
            ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
            localRoots,
            readFile,
            ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
            ...(params.proxyUrl ? { proxyUrl: params.proxyUrl } : {}),
            ...(params.requestInit ? { requestInit: params.requestInit } : {}),
            ...(params.trustExplicitProxyDns !== undefined
                ? { trustExplicitProxyDns: params.trustExplicitProxyDns }
                : {}),
            hostReadCapability: true,
            ...(params.optimizeImages !== undefined ? { optimizeImages: params.optimizeImages } : {}),
            ...(workspaceDir ? { workspaceDir } : {}),
        };
    }
    return {
        ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
        ...(localRoots ? { localRoots } : {}),
        ...(params.proxyUrl ? { proxyUrl: params.proxyUrl } : {}),
        ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
        ...(params.requestInit ? { requestInit: params.requestInit } : {}),
        ...(params.trustExplicitProxyDns !== undefined
            ? { trustExplicitProxyDns: params.trustExplicitProxyDns }
            : {}),
        ...(params.optimizeImages !== undefined ? { optimizeImages: params.optimizeImages } : {}),
        ...(workspaceDir ? { workspaceDir } : {}),
    };
}
