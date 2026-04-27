import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ExplicitGatewayAuth, type GatewayCredentialMode, type GatewayCredentialPrecedence, type GatewayRemoteCredentialFallback, type GatewayRemoteCredentialPrecedence } from "./credentials.js";
export type GatewayCredentialSecretInputOptions = {
    config: OpenClawConfig;
    explicitAuth?: ExplicitGatewayAuth;
    urlOverride?: string;
    urlOverrideSource?: "cli" | "env";
    env?: NodeJS.ProcessEnv;
    modeOverride?: GatewayCredentialMode;
    localTokenPrecedence?: GatewayCredentialPrecedence;
    localPasswordPrecedence?: GatewayCredentialPrecedence;
    remoteTokenPrecedence?: GatewayRemoteCredentialPrecedence;
    remotePasswordPrecedence?: GatewayRemoteCredentialPrecedence;
    remoteTokenFallback?: GatewayRemoteCredentialFallback;
    remotePasswordFallback?: GatewayRemoteCredentialFallback;
};
export declare function resolveGatewayCredentialsWithSecretInputs(params: GatewayCredentialSecretInputOptions): Promise<{
    token?: string;
    password?: string;
}>;
