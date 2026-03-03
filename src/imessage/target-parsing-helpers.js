function stripPrefix(value, prefix) {
    return value.slice(prefix.length).trim();
}
export function resolveServicePrefixedTarget(params) {
    for (const { prefix, service } of params.servicePrefixes) {
        if (!params.lower.startsWith(prefix)) {
            continue;
        }
        const remainder = stripPrefix(params.trimmed, prefix);
        if (!remainder) {
            throw new Error(`${prefix} target is required`);
        }
        const remainderLower = remainder.toLowerCase();
        if (params.isChatTarget(remainderLower)) {
            return params.parseTarget(remainder);
        }
        return { kind: "handle", to: remainder, service };
    }
    return null;
}
export function parseChatTargetPrefixesOrThrow(params) {
    for (const prefix of params.chatIdPrefixes) {
        if (params.lower.startsWith(prefix)) {
            const value = stripPrefix(params.trimmed, prefix);
            const chatId = Number.parseInt(value, 10);
            if (!Number.isFinite(chatId)) {
                throw new Error(`Invalid chat_id: ${value}`);
            }
            return { kind: "chat_id", chatId };
        }
    }
    for (const prefix of params.chatGuidPrefixes) {
        if (params.lower.startsWith(prefix)) {
            const value = stripPrefix(params.trimmed, prefix);
            if (!value) {
                throw new Error("chat_guid is required");
            }
            return { kind: "chat_guid", chatGuid: value };
        }
    }
    for (const prefix of params.chatIdentifierPrefixes) {
        if (params.lower.startsWith(prefix)) {
            const value = stripPrefix(params.trimmed, prefix);
            if (!value) {
                throw new Error("chat_identifier is required");
            }
            return { kind: "chat_identifier", chatIdentifier: value };
        }
    }
    return null;
}
export function resolveServicePrefixedAllowTarget(params) {
    for (const { prefix } of params.servicePrefixes) {
        if (!params.lower.startsWith(prefix)) {
            continue;
        }
        const remainder = stripPrefix(params.trimmed, prefix);
        if (!remainder) {
            return { kind: "handle", handle: "" };
        }
        return params.parseAllowTarget(remainder);
    }
    return null;
}
export function parseChatAllowTargetPrefixes(params) {
    for (const prefix of params.chatIdPrefixes) {
        if (params.lower.startsWith(prefix)) {
            const value = stripPrefix(params.trimmed, prefix);
            const chatId = Number.parseInt(value, 10);
            if (Number.isFinite(chatId)) {
                return { kind: "chat_id", chatId };
            }
        }
    }
    for (const prefix of params.chatGuidPrefixes) {
        if (params.lower.startsWith(prefix)) {
            const value = stripPrefix(params.trimmed, prefix);
            if (value) {
                return { kind: "chat_guid", chatGuid: value };
            }
        }
    }
    for (const prefix of params.chatIdentifierPrefixes) {
        if (params.lower.startsWith(prefix)) {
            const value = stripPrefix(params.trimmed, prefix);
            if (value) {
                return { kind: "chat_identifier", chatIdentifier: value };
            }
        }
    }
    return null;
}
