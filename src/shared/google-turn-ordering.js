export const GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT = "(session bootstrap)";
export function sanitizeGoogleAssistantFirstOrdering(messages) {
    const first = messages[0];
    const role = first?.role;
    const content = first?.content;
    if (role === "user" &&
        typeof content === "string" &&
        content.trim() === GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT) {
        return messages;
    }
    if (role !== "assistant") {
        return messages;
    }
    const bootstrap = {
        role: "user",
        content: GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT,
        timestamp: Date.now(),
    };
    return [bootstrap, ...messages];
}
