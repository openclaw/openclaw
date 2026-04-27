export const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 120_000;
export const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 600_000;
export const PLUGIN_APPROVAL_TITLE_MAX_LENGTH = 80;
export const PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH = 256;
export function approvalDecisionLabel(decision) {
    if (decision === "allow-once") {
        return "allowed once";
    }
    if (decision === "allow-always") {
        return "allowed always";
    }
    return "denied";
}
export function buildPluginApprovalRequestMessage(request, nowMsValue) {
    const lines = [];
    const severity = request.request.severity ?? "warning";
    const icon = severity === "critical" ? "🚨" : severity === "info" ? "ℹ️" : "🛡️";
    lines.push(`${icon} Plugin approval required`);
    lines.push(`Title: ${request.request.title}`);
    lines.push(`Description: ${request.request.description}`);
    if (request.request.toolName) {
        lines.push(`Tool: ${request.request.toolName}`);
    }
    if (request.request.pluginId) {
        lines.push(`Plugin: ${request.request.pluginId}`);
    }
    if (request.request.agentId) {
        lines.push(`Agent: ${request.request.agentId}`);
    }
    lines.push(`ID: ${request.id}`);
    const expiresIn = Math.max(0, Math.round((request.expiresAtMs - nowMsValue) / 1000));
    lines.push(`Expires in: ${expiresIn}s`);
    lines.push("Reply with: /approve <id> allow-once|allow-always|deny");
    return lines.join("\n");
}
export function buildPluginApprovalResolvedMessage(resolved) {
    const base = `✅ Plugin approval ${approvalDecisionLabel(resolved.decision)}.`;
    const by = resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : "";
    return `${base}${by} ID: ${resolved.id}`;
}
export function buildPluginApprovalExpiredMessage(request) {
    return `⏱️ Plugin approval expired. ID: ${request.id}`;
}
