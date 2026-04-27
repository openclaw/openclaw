import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
export type GatewayMemoryProbe = {
    checked: boolean;
    ready: boolean;
    error?: string;
};
export declare function checkGatewayHealth(params: {
    runtime: RuntimeEnv;
    cfg: OpenClawConfig;
    timeoutMs?: number;
}): Promise<{
    healthOk: boolean;
}>;
export declare function probeGatewayMemoryStatus(params: {
    cfg: OpenClawConfig;
    timeoutMs?: number;
}): Promise<GatewayMemoryProbe>;
