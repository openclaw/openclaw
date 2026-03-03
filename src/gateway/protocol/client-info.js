export const GATEWAY_CLIENT_IDS = {
    WEBCHAT_UI: "webchat-ui",
    CONTROL_UI: "openclaw-control-ui",
    WEBCHAT: "webchat",
    CLI: "cli",
    GATEWAY_CLIENT: "gateway-client",
    MACOS_APP: "openclaw-macos",
    IOS_APP: "openclaw-ios",
    ANDROID_APP: "openclaw-android",
    NODE_HOST: "node-host",
    TEST: "test",
    FINGERPRINT: "fingerprint",
    PROBE: "openclaw-probe",
};
// Back-compat naming (internal): these values are IDs, not display names.
export const GATEWAY_CLIENT_NAMES = GATEWAY_CLIENT_IDS;
export const GATEWAY_CLIENT_MODES = {
    WEBCHAT: "webchat",
    CLI: "cli",
    UI: "ui",
    BACKEND: "backend",
    NODE: "node",
    PROBE: "probe",
    TEST: "test",
};
export const GATEWAY_CLIENT_CAPS = {
    TOOL_EVENTS: "tool-events",
};
const GATEWAY_CLIENT_ID_SET = new Set(Object.values(GATEWAY_CLIENT_IDS));
const GATEWAY_CLIENT_MODE_SET = new Set(Object.values(GATEWAY_CLIENT_MODES));
export function normalizeGatewayClientId(raw) {
    const normalized = raw?.trim().toLowerCase();
    if (!normalized) {
        return undefined;
    }
    return GATEWAY_CLIENT_ID_SET.has(normalized)
        ? normalized
        : undefined;
}
export function normalizeGatewayClientName(raw) {
    return normalizeGatewayClientId(raw);
}
export function normalizeGatewayClientMode(raw) {
    const normalized = raw?.trim().toLowerCase();
    if (!normalized) {
        return undefined;
    }
    return GATEWAY_CLIENT_MODE_SET.has(normalized)
        ? normalized
        : undefined;
}
export function hasGatewayClientCap(caps, cap) {
    if (!Array.isArray(caps)) {
        return false;
    }
    return caps.includes(cap);
}
