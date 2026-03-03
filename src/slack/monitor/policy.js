export function isSlackChannelAllowedByPolicy(params) {
    const { groupPolicy, channelAllowlistConfigured, channelAllowed } = params;
    if (groupPolicy === "disabled") {
        return false;
    }
    if (groupPolicy === "open") {
        return true;
    }
    if (!channelAllowlistConfigured) {
        return false;
    }
    return channelAllowed;
}
