import type { OpenClawConfig } from "../config/types.openclaw.js";
export type GatewayProbeTargetResolution = {
    gatewayMode: "local" | "remote";
    mode: "local" | "remote";
    remoteUrlMissing: boolean;
};
export declare function resolveGatewayProbeTarget(cfg: OpenClawConfig): GatewayProbeTargetResolution;
