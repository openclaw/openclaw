import type { OpenClawConfig } from "../config/types.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import { type StatusOverviewRow } from "./status-all/format.js";
import type { NodeOnlyGatewayInfo } from "./status.node-mode.js";
import type { StatusScanOverviewResult } from "./status.scan-overview.ts";
import type { StatusScanResult } from "./status.scan-result.ts";
type StatusGatewayConnection = {
    url: string;
    urlSource?: string;
};
type StatusGatewayProbe = {
    connectLatencyMs?: number | null;
    error?: string | null;
} | null;
type StatusGatewayAuth = {
    token?: string;
    password?: string;
} | null;
type StatusGatewaySelf = {
    host?: string | null;
    ip?: string | null;
    version?: string | null;
    platform?: string | null;
} | null | undefined;
type StatusServiceSummary = {
    label: string;
    installed: boolean | null;
    managedByOpenClaw?: boolean;
    loadedText: string;
    runtimeShort?: string | null;
    runtime?: {
        status?: string | null;
        pid?: number | null;
    } | null;
};
export type StatusOverviewSurface = {
    cfg: Pick<OpenClawConfig, "update" | "gateway">;
    update: UpdateCheckResult;
    tailscaleMode: string;
    tailscaleDns?: string | null;
    tailscaleHttpsUrl?: string | null;
    gatewayMode: "local" | "remote";
    remoteUrlMissing: boolean;
    gatewayConnection: StatusGatewayConnection;
    gatewayReachable: boolean;
    gatewayProbe: StatusGatewayProbe;
    gatewayProbeAuth: StatusGatewayAuth;
    gatewayProbeAuthWarning?: string | null;
    gatewaySelf: StatusGatewaySelf;
    gatewayService: StatusServiceSummary;
    nodeService: StatusServiceSummary;
    nodeOnlyGateway?: NodeOnlyGatewayInfo | null;
};
export declare function buildStatusOverviewSurfaceFromScan(params: {
    scan: Pick<StatusScanResult, "cfg" | "update" | "tailscaleMode" | "tailscaleDns" | "tailscaleHttpsUrl" | "gatewayMode" | "remoteUrlMissing" | "gatewayConnection" | "gatewayReachable" | "gatewayProbe" | "gatewayProbeAuth" | "gatewayProbeAuthWarning" | "gatewaySelf">;
    gatewayService: StatusServiceSummary;
    nodeService: StatusServiceSummary;
    nodeOnlyGateway?: NodeOnlyGatewayInfo | null;
}): StatusOverviewSurface;
export declare function buildStatusOverviewSurfaceFromOverview(params: {
    overview: Pick<StatusScanOverviewResult, "cfg" | "update" | "tailscaleMode" | "tailscaleDns" | "tailscaleHttpsUrl" | "gatewaySnapshot">;
    gatewayService: StatusServiceSummary;
    nodeService: StatusServiceSummary;
    nodeOnlyGateway?: NodeOnlyGatewayInfo | null;
}): StatusOverviewSurface;
export declare function buildStatusOverviewRowsFromSurface(params: {
    surface: StatusOverviewSurface;
    prefixRows?: StatusOverviewRow[];
    middleRows?: StatusOverviewRow[];
    suffixRows?: StatusOverviewRow[];
    agentsValue: string;
    updateValue?: string;
    gatewayAuthWarningValue?: string | null;
    gatewaySelfFallbackValue?: string | null;
    tailscaleBackendState?: string | null;
    includeBackendStateWhenOff?: boolean;
    includeBackendStateWhenOn?: boolean;
    includeDnsNameWhenOff?: boolean;
    decorateOk?: (value: string) => string;
    decorateWarn?: (value: string) => string;
    decorateTailscaleOff?: (value: string) => string;
    decorateTailscaleWarn?: (value: string) => string;
}): StatusOverviewRow[];
export declare function buildStatusGatewayJsonPayloadFromSurface(params: {
    surface: Pick<StatusOverviewSurface, "gatewayMode" | "gatewayConnection" | "remoteUrlMissing" | "gatewayReachable" | "gatewayProbe" | "gatewaySelf" | "gatewayProbeAuthWarning">;
}): {
    mode: "local" | "remote";
    url: string;
    urlSource: string | undefined;
    misconfigured: boolean;
    reachable: boolean;
    connectLatencyMs: number | null;
    self: {
        host?: string | null;
        ip?: string | null;
        version?: string | null;
        platform?: string | null;
    } | null;
    error: string | null;
    authWarning: string | null;
};
export {};
