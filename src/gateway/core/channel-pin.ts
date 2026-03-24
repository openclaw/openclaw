/**
 * Pins the channel registry at startup to ensure stability during mid-flight registry swaps.
 * Addresses #53944.
 */
let pinnedChannelRegistry: any = null;

export function pinChannelRegistry(registry: any) {
    console.info("[gateway] Pinning channel registry for session stability.");
    pinnedChannelRegistry = registry;
}

export function getPinnedChannelRegistry() {
    return pinnedChannelRegistry;
}

export function releaseChannelRegistry() {
    pinnedChannelRegistry = null;
}
