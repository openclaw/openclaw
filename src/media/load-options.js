export function resolveOutboundMediaLocalRoots(mediaLocalRoots) {
    return mediaLocalRoots && mediaLocalRoots.length > 0 ? mediaLocalRoots : undefined;
}
export function buildOutboundMediaLoadOptions(params = {}) {
    const localRoots = resolveOutboundMediaLocalRoots(params.mediaLocalRoots);
    return {
        ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
        ...(localRoots ? { localRoots } : {}),
    };
}
