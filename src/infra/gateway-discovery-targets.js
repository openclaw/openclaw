import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveGatewayDiscoveryEndpoint, } from "./bonjour-discovery.js";
function pickSshPort(beacon) {
    return typeof beacon.sshPort === "number" && Number.isFinite(beacon.sshPort) && beacon.sshPort > 0
        ? beacon.sshPort
        : null;
}
export function buildGatewayDiscoveryTarget(beacon, opts) {
    const endpoint = resolveGatewayDiscoveryEndpoint(beacon);
    const sshPort = pickSshPort(beacon);
    const sshUser = normalizeOptionalString(opts?.sshUser) ?? "";
    const baseSshTarget = endpoint ? (sshUser ? `${sshUser}@${endpoint.host}` : endpoint.host) : null;
    const sshTarget = baseSshTarget && sshPort && sshPort !== 22 ? `${baseSshTarget}:${sshPort}` : baseSshTarget;
    return {
        title: normalizeOptionalString(beacon.displayName || beacon.instanceName || "Gateway") ?? "Gateway",
        domain: normalizeOptionalString(beacon.domain || "local.") ?? "local.",
        endpoint,
        wsUrl: endpoint?.wsUrl ?? null,
        sshPort,
        sshTarget,
    };
}
export function buildGatewayDiscoveryLabel(beacon) {
    const target = buildGatewayDiscoveryTarget(beacon);
    const hint = target.endpoint ? `${target.endpoint.host}:${target.endpoint.port}` : "host unknown";
    return `${target.title} (${hint})`;
}
export function serializeGatewayDiscoveryBeacon(beacon) {
    const target = buildGatewayDiscoveryTarget(beacon);
    return {
        instanceName: beacon.instanceName,
        displayName: beacon.displayName ?? null,
        domain: beacon.domain ?? null,
        host: beacon.host ?? null,
        lanHost: beacon.lanHost ?? null,
        tailnetDns: beacon.tailnetDns ?? null,
        gatewayPort: beacon.gatewayPort ?? null,
        sshPort: beacon.sshPort ?? null,
        wsUrl: target.wsUrl,
    };
}
