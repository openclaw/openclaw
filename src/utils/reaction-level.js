const LEVELS = new Set(["off", "ack", "minimal", "extensive"]);
function parseLevel(value) {
    if (value === undefined || value === null) {
        return { kind: "missing" };
    }
    if (typeof value !== "string") {
        return { kind: "invalid" };
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return { kind: "missing" };
    }
    if (LEVELS.has(trimmed)) {
        return { kind: "ok", value: trimmed };
    }
    return { kind: "invalid" };
}
export function resolveReactionLevel(params) {
    const parsed = parseLevel(params.value);
    const effective = parsed.kind === "ok"
        ? parsed.value
        : parsed.kind === "missing"
            ? params.defaultLevel
            : params.invalidFallback;
    switch (effective) {
        case "off":
            return { level: "off", ackEnabled: false, agentReactionsEnabled: false };
        case "ack":
            return { level: "ack", ackEnabled: true, agentReactionsEnabled: false };
        case "minimal":
            return {
                level: "minimal",
                ackEnabled: false,
                agentReactionsEnabled: true,
                agentReactionGuidance: "minimal",
            };
        case "extensive":
            return {
                level: "extensive",
                ackEnabled: false,
                agentReactionsEnabled: true,
                agentReactionGuidance: "extensive",
            };
        default:
            return {
                level: "minimal",
                ackEnabled: false,
                agentReactionsEnabled: true,
                agentReactionGuidance: "minimal",
            };
    }
}
