export function visitObjectContentBlocks(message, visitor) {
    if (!message || typeof message !== "object") {
        return;
    }
    const content = message.content;
    if (!Array.isArray(content)) {
        return;
    }
    for (const block of content) {
        if (!block || typeof block !== "object") {
            continue;
        }
        visitor(block);
    }
}
