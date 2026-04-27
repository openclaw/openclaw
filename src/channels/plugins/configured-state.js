import { hasBundledChannelPackageState, listBundledChannelIdsForPackageState, } from "./package-state-probes.js";
export function listBundledChannelIdsWithConfiguredState() {
    return listBundledChannelIdsForPackageState("configuredState");
}
export function hasBundledChannelConfiguredState(params) {
    return hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: params.channelId,
        cfg: params.cfg,
        env: params.env,
    });
}
