import { DEFAULT_GATEWAY_PORT } from "../config/paths.js";
import { loadNodeHostConfig } from "../node-host/config.js";
function resolveNodeGatewayTarget(gateway) {
    return gateway?.host
        ? `${gateway.host}:${gateway.port ?? DEFAULT_GATEWAY_PORT}`
        : "(gateway address unknown)";
}
function hasRunningRuntime(runtime) {
    return runtime?.status === "running" || typeof runtime?.pid === "number";
}
function isNodeServiceActive(node) {
    if (node.installed !== true) {
        return false;
    }
    if (node.externallyManaged === true) {
        return true;
    }
    if (node.loaded === true) {
        return true;
    }
    if (hasRunningRuntime(node.runtime)) {
        return true;
    }
    return typeof node.runtimeShort === "string" && node.runtimeShort.startsWith("running");
}
export async function resolveNodeOnlyGatewayInfo(params) {
    if (params.daemon.installed !== false || !isNodeServiceActive(params.node)) {
        return null;
    }
    const gatewayTarget = resolveNodeGatewayTarget((await loadNodeHostConfig())?.gateway);
    return {
        gatewayTarget,
        gatewayValue: `node → ${gatewayTarget} · no local gateway`,
        connectionDetails: [
            "Node-only mode detected",
            "Local gateway: not expected on this machine",
            `Remote gateway target: ${gatewayTarget}`,
            "Inspect the remote gateway host for live channel and health details.",
        ].join("\n"),
    };
}
