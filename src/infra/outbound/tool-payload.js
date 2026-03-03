export function extractToolPayload(result) {
    if (result.details !== undefined) {
        return result.details;
    }
    const textBlock = Array.isArray(result.content)
        ? result.content.find((block) => block &&
            typeof block === "object" &&
            block.type === "text" &&
            typeof block.text === "string")
        : undefined;
    const text = textBlock?.text;
    if (text) {
        try {
            return JSON.parse(text);
        }
        catch {
            return text;
        }
    }
    return result.content ?? result;
}
