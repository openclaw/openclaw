import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { INTERNAL_MESSAGE_CHANNEL, isDeliverableMessageChannel, normalizeMessageChannel, } from "../../utils/message-channel.js";
export function resolveExternalBestEffortDeliveryTarget(params) {
    const normalizedChannel = normalizeMessageChannel(params.channel);
    const channel = normalizedChannel && isDeliverableMessageChannel(normalizedChannel)
        ? normalizedChannel
        : undefined;
    const to = normalizeOptionalString(params.to);
    const deliver = Boolean(channel && to);
    return {
        deliver,
        channel: deliver ? channel : undefined,
        to: deliver ? to : undefined,
        accountId: deliver ? normalizeOptionalString(params.accountId) : undefined,
        threadId: deliver && params.threadId != null && params.threadId !== ""
            ? String(params.threadId)
            : undefined,
    };
}
export function shouldDowngradeDeliveryToSessionOnly(params) {
    return (params.wantsDelivery &&
        params.bestEffortDeliver &&
        params.resolvedChannel === INTERNAL_MESSAGE_CHANNEL);
}
