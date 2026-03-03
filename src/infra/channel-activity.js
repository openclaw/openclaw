const activity = new Map();
function keyFor(channel, accountId) {
    return `${channel}:${accountId || "default"}`;
}
function ensureEntry(channel, accountId) {
    const key = keyFor(channel, accountId);
    const existing = activity.get(key);
    if (existing) {
        return existing;
    }
    const created = { inboundAt: null, outboundAt: null };
    activity.set(key, created);
    return created;
}
export function recordChannelActivity(params) {
    const at = typeof params.at === "number" ? params.at : Date.now();
    const accountId = params.accountId?.trim() || "default";
    const entry = ensureEntry(params.channel, accountId);
    if (params.direction === "inbound") {
        entry.inboundAt = at;
    }
    if (params.direction === "outbound") {
        entry.outboundAt = at;
    }
}
export function getChannelActivity(params) {
    const accountId = params.accountId?.trim() || "default";
    return (activity.get(keyFor(params.channel, accountId)) ?? {
        inboundAt: null,
        outboundAt: null,
    });
}
export function resetChannelActivityForTest() {
    activity.clear();
}
