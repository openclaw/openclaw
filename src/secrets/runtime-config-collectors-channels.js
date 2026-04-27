import { getBootstrapChannelSecrets } from "../channels/plugins/bootstrap-registry.js";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";
export function collectChannelConfigAssignments(params) {
    const channelIds = Object.keys(params.config.channels ?? {});
    if (channelIds.length === 0) {
        return;
    }
    for (const channelId of channelIds) {
        const contract = loadBundledChannelSecretContractApi(channelId);
        const collectRuntimeConfigAssignments = contract?.collectRuntimeConfigAssignments ??
            getBootstrapChannelSecrets(channelId)?.collectRuntimeConfigAssignments;
        collectRuntimeConfigAssignments?.(params);
    }
}
