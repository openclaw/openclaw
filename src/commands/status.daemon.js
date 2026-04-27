import { resolveNodeService } from "../daemon/node-service.js";
import { resolveGatewayService } from "../daemon/service.js";
import { formatDaemonRuntimeShort } from "./status.format.js";
import { readServiceStatusSummary } from "./status.service-summary.js";
async function buildDaemonStatusSummary(serviceLabel) {
    const service = serviceLabel === "gateway" ? resolveGatewayService() : resolveNodeService();
    const fallbackLabel = serviceLabel === "gateway" ? "Daemon" : "Node";
    const summary = await readServiceStatusSummary(service, fallbackLabel);
    return {
        label: summary.label,
        installed: summary.installed,
        loaded: summary.loaded,
        managedByOpenClaw: summary.managedByOpenClaw,
        externallyManaged: summary.externallyManaged,
        loadedText: summary.loadedText,
        runtime: summary.runtime,
        runtimeShort: formatDaemonRuntimeShort(summary.runtime),
    };
}
export async function getDaemonStatusSummary() {
    return await buildDaemonStatusSummary("gateway");
}
export async function getNodeDaemonStatusSummary() {
    return await buildDaemonStatusSummary("node");
}
