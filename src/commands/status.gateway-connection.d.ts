import type { RuntimeEnv } from "../runtime.js";
import type { NodeOnlyGatewayInfo } from "./status.node-mode.js";
import type { StatusScanOverviewResult } from "./status.scan-overview.ts";
export declare function logGatewayConnectionDetails(params: {
    runtime: Pick<RuntimeEnv, "log">;
    info: (value: string) => string;
    message: string;
    trailingBlankLine?: boolean;
}): void;
export declare function resolveStatusAllConnectionDetails(params: {
    nodeOnlyGateway: NodeOnlyGatewayInfo | null;
    remoteUrlMissing: boolean;
    gatewayConnection: StatusScanOverviewResult["gatewaySnapshot"]["gatewayConnection"];
    bindMode?: string | null;
    configPath: string;
}): string;
