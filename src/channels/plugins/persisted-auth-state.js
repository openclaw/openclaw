import { hasBundledChannelPackageState, listBundledChannelIdsForPackageState, } from "./package-state-probes.js";
export function listBundledChannelIdsWithPersistedAuthState() {
    return listBundledChannelIdsForPackageState("persistedAuthState");
}
export function hasBundledChannelPersistedAuthState(params) {
    return hasBundledChannelPackageState({
        metadataKey: "persistedAuthState",
        channelId: params.channelId,
        cfg: params.cfg,
        env: params.env,
    });
}
