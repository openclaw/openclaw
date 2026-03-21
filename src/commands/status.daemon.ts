import { resolveNodeService } from "../daemon/node-service.js";
import { resolveGatewayService } from "../daemon/service.js";
import { formatDaemonRuntimeShort } from "./status.format.js";
import { readServiceStatusSummary } from "./status.service-summary.js";

type DaemonStatusSummary = {
  label: string;
  installed: boolean | null;
  managedByOpenClaw: boolean;
  externallyManaged: boolean;
  loadedText: string;
  runtimeShort: string | null;
};

async function buildDaemonStatusSummary(
  serviceLabel: "gateway" | "node",
): Promise<DaemonStatusSummary> {
  const service = serviceLabel === "gateway" ? resolveGatewayService() : resolveNodeService();
  const fallbackLabel = serviceLabel === "gateway" ? "Daemon" : "Node";
  const summary = await readServiceStatusSummary(service, fallbackLabel);
  return {
    label: summary.label,
    installed: summary.installed,
    managedByOpenClaw: summary.managedByOpenClaw,
    externallyManaged: summary.externallyManaged,
    loadedText: summary.loadedText,
    runtimeShort: formatDaemonRuntimeShort(summary.runtime),
  };
}

export async function getDaemonStatusSummary(): Promise<DaemonStatusSummary> {
  return await buildDaemonStatusSummary("gateway");
}

export async function getNodeDaemonStatusSummary(): Promise<DaemonStatusSummary> {
  return await buildDaemonStatusSummary("node");
}
