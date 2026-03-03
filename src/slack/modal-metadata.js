const SLACK_PRIVATE_METADATA_MAX = 3000;
function normalizeString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
export function parseSlackModalPrivateMetadata(raw) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        return {
            sessionKey: normalizeString(parsed.sessionKey),
            channelId: normalizeString(parsed.channelId),
            channelType: normalizeString(parsed.channelType),
            userId: normalizeString(parsed.userId),
        };
    }
    catch {
        return {};
    }
}
export function encodeSlackModalPrivateMetadata(input) {
    const payload = {
        ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
        ...(input.channelId ? { channelId: input.channelId } : {}),
        ...(input.channelType ? { channelType: input.channelType } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
    };
    const encoded = JSON.stringify(payload);
    if (encoded.length > SLACK_PRIVATE_METADATA_MAX) {
        throw new Error(`Slack modal private_metadata cannot exceed ${SLACK_PRIVATE_METADATA_MAX} chars`);
    }
    return encoded;
}
