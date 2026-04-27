import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
export declare function promptGatewayConfig(cfg: OpenClawConfig, runtime: RuntimeEnv): Promise<{
    config: OpenClawConfig;
    port: number;
    token?: string;
}>;
