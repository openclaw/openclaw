import { resolveAgentConfig } from "./agent-scope.js";
function trimNonEmpty(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
export function resolveSystemPromptOverride(params) {
    const config = params.config;
    if (!config) {
        return undefined;
    }
    const agentOverride = trimNonEmpty(params.agentId ? resolveAgentConfig(config, params.agentId)?.systemPromptOverride : undefined);
    if (agentOverride) {
        return agentOverride;
    }
    return trimNonEmpty(config.agents?.defaults?.systemPromptOverride);
}
