import type { OpenClawConfig } from "../config/types.js";
import { type ExplicitGatewayAuth } from "./credentials.js";
export declare function resolveGatewayProbeSurfaceAuth(params: {
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    surface: "local" | "remote";
}): Promise<{
    token?: string;
    password?: string;
    diagnostics?: string[];
}>;
export declare function resolveGatewayInteractiveSurfaceAuth(params: {
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    explicitAuth?: ExplicitGatewayAuth;
    suppressEnvAuthFallback?: boolean;
    surface: "local" | "remote";
}): Promise<{
    token?: string;
    password?: string;
    failureReason?: string;
}>;
