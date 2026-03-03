// Default service labels (canonical + legacy compatibility)
export const GATEWAY_LAUNCH_AGENT_LABEL = "ai.openclaw.gateway";
export const GATEWAY_SYSTEMD_SERVICE_NAME = "openclaw-gateway";
export const GATEWAY_WINDOWS_TASK_NAME = "OpenClaw Gateway";
export const GATEWAY_SERVICE_MARKER = "openclaw";
export const GATEWAY_SERVICE_KIND = "gateway";
export const NODE_LAUNCH_AGENT_LABEL = "ai.openclaw.node";
export const NODE_SYSTEMD_SERVICE_NAME = "openclaw-node";
export const NODE_WINDOWS_TASK_NAME = "OpenClaw Node";
export const NODE_SERVICE_MARKER = "openclaw";
export const NODE_SERVICE_KIND = "node";
export const NODE_WINDOWS_TASK_SCRIPT_NAME = "node.cmd";
export const LEGACY_GATEWAY_LAUNCH_AGENT_LABELS = [];
export const LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES = [
    "clawdbot-gateway",
    "moltbot-gateway",
];
export const LEGACY_GATEWAY_WINDOWS_TASK_NAMES = [];
export function normalizeGatewayProfile(profile) {
    const trimmed = profile?.trim();
    if (!trimmed || trimmed.toLowerCase() === "default") {
        return null;
    }
    return trimmed;
}
export function resolveGatewayProfileSuffix(profile) {
    const normalized = normalizeGatewayProfile(profile);
    return normalized ? `-${normalized}` : "";
}
export function resolveGatewayLaunchAgentLabel(profile) {
    const normalized = normalizeGatewayProfile(profile);
    if (!normalized) {
        return GATEWAY_LAUNCH_AGENT_LABEL;
    }
    return `ai.openclaw.${normalized}`;
}
export function resolveLegacyGatewayLaunchAgentLabels(profile) {
    void profile;
    return [];
}
export function resolveGatewaySystemdServiceName(profile) {
    const suffix = resolveGatewayProfileSuffix(profile);
    if (!suffix) {
        return GATEWAY_SYSTEMD_SERVICE_NAME;
    }
    return `openclaw-gateway${suffix}`;
}
export function resolveGatewayWindowsTaskName(profile) {
    const normalized = normalizeGatewayProfile(profile);
    if (!normalized) {
        return GATEWAY_WINDOWS_TASK_NAME;
    }
    return `OpenClaw Gateway (${normalized})`;
}
export function formatGatewayServiceDescription(params) {
    const profile = normalizeGatewayProfile(params?.profile);
    const version = params?.version?.trim();
    const parts = [];
    if (profile) {
        parts.push(`profile: ${profile}`);
    }
    if (version) {
        parts.push(`v${version}`);
    }
    if (parts.length === 0) {
        return "OpenClaw Gateway";
    }
    return `OpenClaw Gateway (${parts.join(", ")})`;
}
export function resolveGatewayServiceDescription(params) {
    return (params.description ??
        formatGatewayServiceDescription({
            profile: params.env.OPENCLAW_PROFILE,
            version: params.environment?.OPENCLAW_SERVICE_VERSION ?? params.env.OPENCLAW_SERVICE_VERSION,
        }));
}
export function resolveNodeLaunchAgentLabel() {
    return NODE_LAUNCH_AGENT_LABEL;
}
export function resolveNodeSystemdServiceName() {
    return NODE_SYSTEMD_SERVICE_NAME;
}
export function resolveNodeWindowsTaskName() {
    return NODE_WINDOWS_TASK_NAME;
}
export function formatNodeServiceDescription(params) {
    const version = params?.version?.trim();
    if (!version) {
        return "OpenClaw Node Host";
    }
    return `OpenClaw Node Host (v${version})`;
}
