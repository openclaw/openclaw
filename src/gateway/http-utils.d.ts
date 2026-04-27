import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type GatewayAuthResult, type ResolvedGatewayAuth } from "./auth.js";
export declare const OPENCLAW_MODEL_ID = "openclaw";
export declare const OPENCLAW_DEFAULT_MODEL_ID = "openclaw/default";
export declare function getHeader(req: IncomingMessage, name: string): string | undefined;
export declare function getBearerToken(req: IncomingMessage): string | undefined;
type SharedSecretGatewayAuth = Pick<ResolvedGatewayAuth, "mode">;
export type AuthorizedGatewayHttpRequest = {
    authMethod?: GatewayAuthResult["method"];
    trustDeclaredOperatorScopes: boolean;
};
export type GatewayHttpRequestAuthCheckResult = {
    ok: true;
    requestAuth: AuthorizedGatewayHttpRequest;
} | {
    ok: false;
    authResult: GatewayAuthResult;
};
export declare function resolveHttpBrowserOriginPolicy(req: IncomingMessage, cfg?: OpenClawConfig): NonNullable<Parameters<typeof authorizeHttpGatewayConnect>[0]["browserOriginPolicy"]>;
export declare function authorizeGatewayHttpRequestOrReply(params: {
    req: IncomingMessage;
    res: ServerResponse;
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
}): Promise<AuthorizedGatewayHttpRequest | null>;
export declare function checkGatewayHttpRequestAuth(params: {
    req: IncomingMessage;
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
    cfg?: OpenClawConfig;
}): Promise<GatewayHttpRequestAuthCheckResult>;
export declare function authorizeScopedGatewayHttpRequestOrReply(params: {
    req: IncomingMessage;
    res: ServerResponse;
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
    operatorMethod: string;
    resolveOperatorScopes: (req: IncomingMessage, requestAuth: AuthorizedGatewayHttpRequest) => string[];
}): Promise<{
    cfg: OpenClawConfig;
    requestAuth: AuthorizedGatewayHttpRequest;
} | null>;
export declare function isGatewayBearerHttpRequest(req: IncomingMessage, auth?: SharedSecretGatewayAuth): boolean;
export declare function resolveTrustedHttpOperatorScopes(req: IncomingMessage, authOrRequest?: SharedSecretGatewayAuth | Pick<AuthorizedGatewayHttpRequest, "trustDeclaredOperatorScopes">): string[];
export declare function resolveOpenAiCompatibleHttpOperatorScopes(req: IncomingMessage, requestAuth: AuthorizedGatewayHttpRequest): string[];
export declare function resolveHttpSenderIsOwner(req: IncomingMessage, authOrRequest?: SharedSecretGatewayAuth | Pick<AuthorizedGatewayHttpRequest, "trustDeclaredOperatorScopes">): boolean;
export declare function resolveOpenAiCompatibleHttpSenderIsOwner(req: IncomingMessage, requestAuth: AuthorizedGatewayHttpRequest): boolean;
export declare function resolveAgentIdFromHeader(req: IncomingMessage): string | undefined;
export declare function resolveAgentIdFromModel(model: string | undefined, cfg?: OpenClawConfig): string | undefined;
export declare function resolveOpenAiCompatModelOverride(params: {
    req: IncomingMessage;
    agentId: string;
    model: string | undefined;
}): Promise<{
    modelOverride?: string;
    errorMessage?: string;
}>;
export declare function resolveAgentIdForRequest(params: {
    req: IncomingMessage;
    model: string | undefined;
}): string;
export declare function resolveSessionKey(params: {
    req: IncomingMessage;
    agentId: string;
    user?: string | undefined;
    prefix: string;
}): string;
export declare function resolveGatewayRequestContext(params: {
    req: IncomingMessage;
    model: string | undefined;
    user?: string | undefined;
    sessionPrefix: string;
    defaultMessageChannel: string;
    useMessageChannelHeader?: boolean;
}): {
    agentId: string;
    sessionKey: string;
    messageChannel: string;
};
export {};
