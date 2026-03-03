function readString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    return value;
}
function normalizeChannel(value) {
    return value.trim().toLowerCase();
}
export function migrateLegacyCronPayload(payload) {
    let mutated = false;
    const channelValue = readString(payload.channel);
    const providerValue = readString(payload.provider);
    const nextChannel = typeof channelValue === "string" && channelValue.trim().length > 0
        ? normalizeChannel(channelValue)
        : typeof providerValue === "string" && providerValue.trim().length > 0
            ? normalizeChannel(providerValue)
            : "";
    if (nextChannel) {
        if (channelValue !== nextChannel) {
            payload.channel = nextChannel;
            mutated = true;
        }
    }
    if ("provider" in payload) {
        delete payload.provider;
        mutated = true;
    }
    return mutated;
}
