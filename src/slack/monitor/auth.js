import { readStoreAllowFromForDmPolicy } from "../../security/dm-policy-shared.js";
import { allowListMatches, normalizeAllowList, normalizeAllowListLower, resolveSlackUserAllowed, } from "./allow-list.js";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { normalizeSlackChannelType } from "./context.js";
export async function resolveSlackEffectiveAllowFrom(ctx, options) {
    const includePairingStore = options?.includePairingStore === true;
    let storeAllowFrom = [];
    if (includePairingStore) {
        try {
            const resolved = await readStoreAllowFromForDmPolicy({
                provider: "slack",
                accountId: ctx.accountId,
                dmPolicy: ctx.dmPolicy,
            });
            storeAllowFrom = Array.isArray(resolved) ? resolved : [];
        }
        catch {
            storeAllowFrom = [];
        }
    }
    const allowFrom = normalizeAllowList([...ctx.allowFrom, ...storeAllowFrom]);
    const allowFromLower = normalizeAllowListLower(allowFrom);
    return { allowFrom, allowFromLower };
}
export function isSlackSenderAllowListed(params) {
    const { allowListLower, senderId, senderName, allowNameMatching } = params;
    return (allowListLower.length === 0 ||
        allowListMatches({
            allowList: allowListLower,
            id: senderId,
            name: senderName,
            allowNameMatching,
        }));
}
export async function authorizeSlackSystemEventSender(params) {
    const senderId = params.senderId?.trim();
    if (!senderId) {
        return { allowed: false, reason: "missing-sender" };
    }
    const expectedSenderId = params.expectedSenderId?.trim();
    if (expectedSenderId && expectedSenderId !== senderId) {
        return { allowed: false, reason: "sender-mismatch" };
    }
    const channelId = params.channelId?.trim();
    let channelType = normalizeSlackChannelType(params.channelType, channelId);
    let channelName;
    if (channelId) {
        const info = await params.ctx.resolveChannelName(channelId).catch(() => ({}));
        channelName = info.name;
        channelType = normalizeSlackChannelType(params.channelType ?? info.type, channelId);
        if (!params.ctx.isChannelAllowed({
            channelId,
            channelName,
            channelType,
        })) {
            return {
                allowed: false,
                reason: "channel-not-allowed",
                channelType,
                channelName,
            };
        }
    }
    const senderInfo = await params.ctx
        .resolveUserName(senderId)
        .catch(() => ({}));
    const senderName = senderInfo.name;
    const resolveAllowFromLower = async (includePairingStore = false) => (await resolveSlackEffectiveAllowFrom(params.ctx, { includePairingStore })).allowFromLower;
    if (channelType === "im") {
        if (!params.ctx.dmEnabled || params.ctx.dmPolicy === "disabled") {
            return { allowed: false, reason: "dm-disabled", channelType, channelName };
        }
        if (params.ctx.dmPolicy !== "open") {
            const allowFromLower = await resolveAllowFromLower(true);
            const senderAllowListed = isSlackSenderAllowListed({
                allowListLower: allowFromLower,
                senderId,
                senderName,
                allowNameMatching: params.ctx.allowNameMatching,
            });
            if (!senderAllowListed) {
                return {
                    allowed: false,
                    reason: "sender-not-allowlisted",
                    channelType,
                    channelName,
                };
            }
        }
    }
    else if (!channelId) {
        // No channel context. Apply allowFrom if configured so we fail closed
        // for privileged interactive events when owner allowlist is present.
        const allowFromLower = await resolveAllowFromLower(false);
        if (allowFromLower.length > 0) {
            const senderAllowListed = isSlackSenderAllowListed({
                allowListLower: allowFromLower,
                senderId,
                senderName,
                allowNameMatching: params.ctx.allowNameMatching,
            });
            if (!senderAllowListed) {
                return { allowed: false, reason: "sender-not-allowlisted" };
            }
        }
    }
    else {
        const channelConfig = resolveSlackChannelConfig({
            channelId,
            channelName,
            channels: params.ctx.channelsConfig,
            defaultRequireMention: params.ctx.defaultRequireMention,
        });
        const channelUsersAllowlistConfigured = Array.isArray(channelConfig?.users) && channelConfig.users.length > 0;
        if (channelUsersAllowlistConfigured) {
            const channelUserAllowed = resolveSlackUserAllowed({
                allowList: channelConfig?.users,
                userId: senderId,
                userName: senderName,
                allowNameMatching: params.ctx.allowNameMatching,
            });
            if (!channelUserAllowed) {
                return {
                    allowed: false,
                    reason: "sender-not-channel-allowed",
                    channelType,
                    channelName,
                };
            }
        }
    }
    return {
        allowed: true,
        channelType,
        channelName,
    };
}
