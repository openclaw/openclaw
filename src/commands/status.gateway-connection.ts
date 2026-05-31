import type { RuntimeEnv } from "../runtime.js";
import type { NodeOnlyGatewayInfo } from "./status.node-mode.js";
import type { StatusScanOverviewResult } from "./status.scan-overview.ts";

/** Logs a preformatted gateway connection block with status command styling. */
export function logGatewayConnectionDetails(params: {
  runtime: Pick<RuntimeEnv, "log">;
  info: (value: string) => string;
  message: string;
  trailingBlankLine?: boolean;
}) {
  params.runtime.log(params.info("Gateway connection:"));
  for (const line of params.message.split("\n")) {
    params.runtime.log(`  ${line}`);
  }
  if (params.trailingBlankLine) {
    params.runtime.log("");
  }
}

/**
 * Builds the gateway connection block used in pasteable `status --all` reports,
 * including node-only and missing-remote-url fallbacks.
 */
export function resolveStatusAllConnectionDetails(params: {
  nodeOnlyGateway: NodeOnlyGatewayInfo | null;
  remoteUrlMissing: boolean;
  gatewayConnection: StatusScanOverviewResult["gatewaySnapshot"]["gatewayConnection"];
  bindMode?: string | null;
  configPath: string;
}): string {
  if (params.nodeOnlyGateway) {
    return params.nodeOnlyGateway.connectionDetails;
  }
  if (!params.remoteUrlMissing) {
    return params.gatewayConnection.message;
  }
  return [
    "Gateway mode: remote",
    "Gateway target: (missing gateway.remote.url)",
    `Config: ${params.configPath}`,
    `Bind: ${params.bindMode ?? "loopback"}`,
    `Local fallback (used for probes): ${params.gatewayConnection.url}`,
    "Fix: set gateway.remote.url, or set gateway.mode=local.",
  ].join("\n");
}
