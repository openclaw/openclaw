export const TOOLS_BY_SENDER_KEY_TYPES = ["id", "e164", "username", "name"];
export function parseToolsBySenderTypedKey(rawKey) {
    const trimmed = rawKey.trim();
    if (!trimmed) {
        return undefined;
    }
    const lowered = trimmed.toLowerCase();
    for (const type of TOOLS_BY_SENDER_KEY_TYPES) {
        const prefix = `${type}:`;
        if (!lowered.startsWith(prefix)) {
            continue;
        }
        return {
            type,
            value: trimmed.slice(prefix.length),
        };
    }
    return undefined;
}
