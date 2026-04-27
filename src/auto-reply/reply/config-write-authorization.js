import { authorizeConfigWrite, canBypassConfigWritePolicy, formatConfigWriteDeniedMessage, } from "../../channels/plugins/config-writes.js";
export function resolveConfigWriteDeniedText(params) {
    const writeAuth = authorizeConfigWrite({
        cfg: params.cfg,
        origin: { channelId: params.channelId, accountId: params.accountId },
        target: params.target,
        allowBypass: canBypassConfigWritePolicy({
            channel: params.channel ?? "",
            gatewayClientScopes: params.gatewayClientScopes,
        }),
    });
    if (writeAuth.allowed) {
        return null;
    }
    return formatConfigWriteDeniedMessage({
        result: writeAuth,
        fallbackChannelId: params.channelId,
    });
}
