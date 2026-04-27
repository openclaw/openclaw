import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ExplicitGatewayAuth } from "./credentials.js";
export declare function hasExplicitGatewayConnectionAuth(auth?: ExplicitGatewayAuth): boolean;
export declare function canSkipGatewayConfigLoad(params: {
    config?: OpenClawConfig;
    urlOverride?: string;
    explicitAuth?: ExplicitGatewayAuth;
}): boolean;
export declare function isGatewayConfigBypassCommandPath(commandPath: readonly string[]): boolean;
