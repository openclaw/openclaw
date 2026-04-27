import { getChannelPlugin, resolveChannelApprovalCapability } from "../channels/plugins/index.js";
import { isImplicitSameChatApprovalAuthorization } from "../plugin-sdk/approval-auth-helpers.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
export function resolveApprovalCommandAuthorization(params) {
    const channel = normalizeMessageChannel(params.channel);
    if (!channel) {
        return { authorized: true, explicit: false };
    }
    const approvalCapability = resolveChannelApprovalCapability(getChannelPlugin(channel));
    const resolved = approvalCapability?.authorizeActorAction?.({
        cfg: params.cfg,
        accountId: params.accountId,
        senderId: params.senderId,
        action: "approve",
        approvalKind: params.kind,
    });
    if (!resolved) {
        return { authorized: true, explicit: false };
    }
    // Keep `resolved` by reference; cloning before this check would drop the
    // non-enumerable implicit-fallback marker.
    const implicitSameChatAuthorization = isImplicitSameChatApprovalAuthorization(resolved);
    const availability = approvalCapability?.getActionAvailabilityState?.({
        cfg: params.cfg,
        accountId: params.accountId,
        action: "approve",
        approvalKind: params.kind,
    });
    return {
        authorized: resolved.authorized,
        reason: resolved.reason,
        explicit: resolved.authorized
            ? !implicitSameChatAuthorization && availability?.kind !== "disabled"
            : true,
    };
}
