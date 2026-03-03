function isValidPort(port) {
    return Number.isFinite(port) && port > 0 && port <= 65535;
}
function clampPort(port, fallback) {
    return isValidPort(port) ? port : fallback;
}
function derivePort(base, offset, fallback) {
    return clampPort(base + offset, fallback);
}
export const DEFAULT_BRIDGE_PORT = 18790;
export const DEFAULT_BROWSER_CONTROL_PORT = 18791;
export const DEFAULT_CANVAS_HOST_PORT = 18793;
export const DEFAULT_BROWSER_CDP_PORT_RANGE_START = 18800;
export const DEFAULT_BROWSER_CDP_PORT_RANGE_END = 18899;
export function deriveDefaultBridgePort(gatewayPort) {
    return derivePort(gatewayPort, 1, DEFAULT_BRIDGE_PORT);
}
export function deriveDefaultBrowserControlPort(gatewayPort) {
    return derivePort(gatewayPort, 2, DEFAULT_BROWSER_CONTROL_PORT);
}
export function deriveDefaultCanvasHostPort(gatewayPort) {
    return derivePort(gatewayPort, 4, DEFAULT_CANVAS_HOST_PORT);
}
export function deriveDefaultBrowserCdpPortRange(browserControlPort) {
    const start = derivePort(browserControlPort, 9, DEFAULT_BROWSER_CDP_PORT_RANGE_START);
    const end = clampPort(start + (DEFAULT_BROWSER_CDP_PORT_RANGE_END - DEFAULT_BROWSER_CDP_PORT_RANGE_START), DEFAULT_BROWSER_CDP_PORT_RANGE_END);
    if (end < start) {
        return { start, end: start };
    }
    return { start, end };
}
