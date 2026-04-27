import { getChannelPlugin, normalizeChannelId } from "./registry.js";
export function shouldSuppressLocalExecApprovalPrompt(params) {
    const channel = params.channel ? normalizeChannelId(params.channel) : null;
    if (!channel) {
        return false;
    }
    return (getChannelPlugin(channel)?.outbound?.shouldSuppressLocalPayloadPrompt?.({
        cfg: params.cfg,
        accountId: params.accountId,
        payload: params.payload,
        hint: { kind: "approval-pending", approvalKind: "exec" },
    }) ?? false);
}
