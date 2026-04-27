export function countActiveStatusAgents(params) {
    const activeThresholdMs = params.activeThresholdMs ?? 10 * 60_000;
    return params.agentStatus.agents.filter((agent) => agent.lastActiveAgeMs != null && agent.lastActiveAgeMs <= activeThresholdMs).length;
}
export function buildStatusAllAgentsValue(params) {
    const activeAgents = countActiveStatusAgents(params);
    return `${params.agentStatus.agents.length} total · ${params.agentStatus.bootstrapPendingCount} bootstrapping · ${activeAgents} active · ${params.agentStatus.totalSessions} sessions`;
}
export function buildStatusSecretsValue(count) {
    return count > 0 ? `${count} diagnostic${count === 1 ? "" : "s"}` : "none";
}
export function buildStatusEventsValue(params) {
    return params.queuedSystemEvents.length > 0
        ? `${params.queuedSystemEvents.length} queued`
        : "none";
}
export function buildStatusProbesValue(params) {
    return params.health ? params.ok("enabled") : params.muted("skipped (use --deep)");
}
export function buildStatusPluginCompatibilityValue(params) {
    if (params.notices.length === 0) {
        return params.ok("none");
    }
    const pluginCount = new Set(params.notices.map((notice) => notice.pluginId ?? notice.plugin ?? "")).size;
    return params.warn(`${params.notices.length} notice${params.notices.length === 1 ? "" : "s"} · ${pluginCount} plugin${pluginCount === 1 ? "" : "s"}`);
}
export function buildStatusSessionsOverviewValue(params) {
    const defaultCtx = params.sessions.defaults.contextTokens
        ? ` (${params.formatKTokens(params.sessions.defaults.contextTokens)} ctx)`
        : "";
    const storeLabel = params.sessions.paths.length > 1
        ? `${params.sessions.paths.length} stores`
        : (params.sessions.paths[0] ?? "unknown");
    return `${params.sessions.count} active · default ${params.sessions.defaults.model ?? "unknown"}${defaultCtx} · ${storeLabel}`;
}
