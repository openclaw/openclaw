function isToolPayloadTextBlock(block) {
    return (!!block &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string");
}
/**
 * Extract the most useful payload from tool result-like objects shared across
 * outbound core flows and bundled plugin helpers.
 */
export function extractToolPayload(result) {
    if (!result) {
        return undefined;
    }
    if (result.details !== undefined) {
        return result.details;
    }
    const textBlock = Array.isArray(result.content)
        ? result.content.find(isToolPayloadTextBlock)
        : undefined;
    const text = textBlock?.text;
    if (!text) {
        return result.content ?? result;
    }
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
