// Daemon service summary helpers for status output.
// Gateway and node service state share the same normalized shape.

import { resolveNodeService } from "../daemon/node-service.js";
import { resolveGatewayService } from "../daemon/service.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { formatDaemonRuntimeShort } from "./status.format.js";
import { readServiceStatusSummary } from "./status.service-summary.js";

type DaemonStatusSummary = Awaited<ReturnType<typeof readServiceStatusSummary>> & {
  loaded: boolean | null;
  runtimeShort: string | null;
};

async function buildDaemonStatusSummary(
  serviceLabel: "gateway" | "node",
  timeoutMs?: number,
): Promise<DaemonStatusSummary> {
  const service = serviceLabel === "gateway" ? resolveGatewayService() : resolveNodeService();
  const fallbackLabel = serviceLabel === "gateway" ? "Daemon" : "Node";
  const activePackageRoot =
    serviceLabel === "gateway"
      ? await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url, argv1: process.argv[1] })
      : null;
  const summary = await readServiceStatusSummary(
    service,
    fallbackLabel,
    timeoutMs,
    activePackageRoot ?? undefined,
  );
  const runtime = summary.runtime?.inspectionFailure
    ? { ...summary.runtime, detail: `${summary.runtime.detail}; retry with openclaw status --deep` }
    : summary.runtime;
  const loaded =
    summary.loadState.status === "unknown" ? null : summary.loadState.status === "loaded";
  return {
    ...summary,
    loaded,
    runtime,
    runtimeShort: formatDaemonRuntimeShort(runtime),
  };
}

/** Returns the gateway daemon status summary. */
export async function getDaemonStatusSummary(timeoutMs?: number): Promise<DaemonStatusSummary> {
  return await buildDaemonStatusSummary("gateway", timeoutMs);
}

/** Returns the node service status summary. */
export async function getNodeDaemonStatusSummary(timeoutMs?: number): Promise<DaemonStatusSummary> {
  return await buildDaemonStatusSummary("node", timeoutMs);
}
