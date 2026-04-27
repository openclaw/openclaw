import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ExplicitGatewayAuth } from "./credentials.js";
export { resolveGatewayProbeTarget } from "./probe-target.js";
export type { GatewayProbeTargetResolution } from "./probe-target.js";
export declare function resolveGatewayProbeAuth(params: {
    cfg: OpenClawConfig;
    mode: "local" | "remote";
    env?: NodeJS.ProcessEnv;
}): {
    token?: string;
    password?: string;
};
export declare function resolveGatewayProbeAuthWithSecretInputs(params: {
    cfg: OpenClawConfig;
    mode: "local" | "remote";
    env?: NodeJS.ProcessEnv;
    explicitAuth?: ExplicitGatewayAuth;
}): Promise<{
    token?: string;
    password?: string;
}>;
export declare function resolveGatewayProbeAuthSafeWithSecretInputs(params: {
    cfg: OpenClawConfig;
    mode: "local" | "remote";
    env?: NodeJS.ProcessEnv;
    explicitAuth?: ExplicitGatewayAuth;
}): Promise<{
    auth: {
        token?: string;
        password?: string;
    };
    warning?: string;
}>;
export declare function resolveGatewayProbeAuthSafe(params: {
    cfg: OpenClawConfig;
    mode: "local" | "remote";
    env?: NodeJS.ProcessEnv;
    explicitAuth?: ExplicitGatewayAuth;
}): {
    auth: {
        token?: string;
        password?: string;
    };
    warning?: string;
};
