import { randomUUID } from "node:crypto";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { buildAllowedModelSet, modelKey, parseModelRef, resolveDefaultModelForAgent, } from "../agents/model-selection.js";
import { loadConfig } from "../config/config.js";
import { buildAgentMainSessionKey, normalizeAgentId } from "../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, } from "../shared/string-coerce.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { authorizeHttpGatewayConnect, } from "./auth.js";
import { sendGatewayAuthFailure, sendJson } from "./http-common.js";
import { ADMIN_SCOPE, CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { loadGatewayModelCatalog } from "./server-model-catalog.js";
export const OPENCLAW_MODEL_ID = "openclaw";
export const OPENCLAW_DEFAULT_MODEL_ID = "openclaw/default";
export function getHeader(req, name) {
    const raw = req.headers[normalizeLowercaseStringOrEmpty(name)];
    if (typeof raw === "string") {
        return raw;
    }
    if (Array.isArray(raw)) {
        return raw[0];
    }
    return undefined;
}
export function getBearerToken(req) {
    const raw = normalizeOptionalString(getHeader(req, "authorization")) ?? "";
    if (!normalizeLowercaseStringOrEmpty(raw).startsWith("bearer ")) {
        return undefined;
    }
    return normalizeOptionalString(raw.slice(7));
}
export function resolveHttpBrowserOriginPolicy(req, cfg = loadConfig()) {
    return {
        requestHost: getHeader(req, "host"),
        origin: getHeader(req, "origin"),
        allowedOrigins: cfg.gateway?.controlUi?.allowedOrigins,
        allowHostHeaderOriginFallback: cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true,
    };
}
function usesSharedSecretHttpAuth(auth) {
    return auth?.mode === "token" || auth?.mode === "password";
}
function usesSharedSecretGatewayMethod(method) {
    return method === "token" || method === "password";
}
function shouldTrustDeclaredHttpOperatorScopes(req, authOrRequest) {
    if (authOrRequest && "trustDeclaredOperatorScopes" in authOrRequest) {
        return authOrRequest.trustDeclaredOperatorScopes;
    }
    return !isGatewayBearerHttpRequest(req, authOrRequest);
}
export async function authorizeGatewayHttpRequestOrReply(params) {
    const result = await checkGatewayHttpRequestAuth(params);
    if (!result.ok) {
        sendGatewayAuthFailure(params.res, result.authResult);
        return null;
    }
    return result.requestAuth;
}
export async function checkGatewayHttpRequestAuth(params) {
    const token = getBearerToken(params.req);
    const browserOriginPolicy = resolveHttpBrowserOriginPolicy(params.req, params.cfg);
    const authResult = await authorizeHttpGatewayConnect({
        auth: params.auth,
        connectAuth: token ? { token, password: token } : null,
        req: params.req,
        trustedProxies: params.trustedProxies,
        allowRealIpFallback: params.allowRealIpFallback,
        rateLimiter: params.rateLimiter,
        browserOriginPolicy,
    });
    if (!authResult.ok) {
        return {
            ok: false,
            authResult,
        };
    }
    return {
        ok: true,
        requestAuth: {
            authMethod: authResult.method,
            // Shared-secret bearer auth proves possession of the gateway secret, but it
            // does not prove a narrower per-request operator identity. HTTP endpoints
            // must opt in explicitly if they want to treat that shared-secret path as a
            // full trusted-operator surface.
            trustDeclaredOperatorScopes: !usesSharedSecretGatewayMethod(authResult.method),
        },
    };
}
export async function authorizeScopedGatewayHttpRequestOrReply(params) {
    const cfg = loadConfig();
    const requestAuth = await authorizeGatewayHttpRequestOrReply({
        req: params.req,
        res: params.res,
        auth: params.auth,
        trustedProxies: params.trustedProxies ?? cfg.gateway?.trustedProxies,
        allowRealIpFallback: params.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
        rateLimiter: params.rateLimiter,
    });
    if (!requestAuth) {
        return null;
    }
    const requestedScopes = params.resolveOperatorScopes(params.req, requestAuth);
    const scopeAuth = authorizeOperatorScopesForMethod(params.operatorMethod, requestedScopes);
    if (!scopeAuth.allowed) {
        sendJson(params.res, 403, {
            ok: false,
            error: {
                type: "forbidden",
                message: `missing scope: ${scopeAuth.missingScope}`,
            },
        });
        return null;
    }
    return { cfg, requestAuth };
}
export function isGatewayBearerHttpRequest(req, auth) {
    return usesSharedSecretHttpAuth(auth) && Boolean(getBearerToken(req));
}
export function resolveTrustedHttpOperatorScopes(req, authOrRequest) {
    if (!shouldTrustDeclaredHttpOperatorScopes(req, authOrRequest)) {
        // Gateway bearer auth only proves possession of the shared secret. Do not
        // let HTTP clients self-assert operator scopes through request headers.
        return [];
    }
    const headerValue = getHeader(req, "x-openclaw-scopes");
    if (headerValue === undefined) {
        // No scope header present — trusted clients without an explicit header
        // get the default operator scopes (matching pre-#57783 behavior).
        return [...CLI_DEFAULT_OPERATOR_SCOPES];
    }
    const raw = headerValue.trim();
    if (!raw) {
        return [];
    }
    return raw
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0);
}
export function resolveOpenAiCompatibleHttpOperatorScopes(req, requestAuth) {
    if (usesSharedSecretGatewayMethod(requestAuth.authMethod)) {
        // Shared-secret HTTP bearer auth is a documented trusted-operator surface
        // for the compat APIs and direct /tools/invoke. This is designed-as-is:
        // token/password auth proves possession of the gateway operator secret, not
        // a narrower per-request scope identity, so restore the normal defaults.
        return [...CLI_DEFAULT_OPERATOR_SCOPES];
    }
    return resolveTrustedHttpOperatorScopes(req, requestAuth);
}
export function resolveHttpSenderIsOwner(req, authOrRequest) {
    return resolveTrustedHttpOperatorScopes(req, authOrRequest).includes(ADMIN_SCOPE);
}
export function resolveOpenAiCompatibleHttpSenderIsOwner(req, requestAuth) {
    if (usesSharedSecretGatewayMethod(requestAuth.authMethod)) {
        // Shared-secret HTTP bearer auth also carries owner semantics on the compat
        // APIs and direct /tools/invoke. This is intentional: there is no separate
        // per-request owner primitive on that shared-secret path, so owner-only
        // tool policy follows the documented trusted-operator contract.
        return true;
    }
    return resolveHttpSenderIsOwner(req, requestAuth);
}
export function resolveAgentIdFromHeader(req) {
    const raw = normalizeOptionalString(getHeader(req, "x-openclaw-agent-id")) ||
        normalizeOptionalString(getHeader(req, "x-openclaw-agent")) ||
        "";
    if (!raw) {
        return undefined;
    }
    return normalizeAgentId(raw);
}
export function resolveAgentIdFromModel(model, cfg = loadConfig()) {
    const raw = model?.trim();
    if (!raw) {
        return undefined;
    }
    const lowered = normalizeLowercaseStringOrEmpty(raw);
    if (lowered === OPENCLAW_MODEL_ID || lowered === OPENCLAW_DEFAULT_MODEL_ID) {
        return resolveDefaultAgentId(cfg);
    }
    const m = raw.match(/^openclaw[:/](?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i) ??
        raw.match(/^agent:(?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i);
    const agentId = m?.groups?.agentId;
    if (!agentId) {
        return undefined;
    }
    return normalizeAgentId(agentId);
}
export async function resolveOpenAiCompatModelOverride(params) {
    const requestModel = params.model?.trim();
    if (requestModel && !resolveAgentIdFromModel(requestModel)) {
        return {
            errorMessage: "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.",
        };
    }
    const raw = getHeader(params.req, "x-openclaw-model")?.trim();
    if (!raw) {
        return {};
    }
    const cfg = loadConfig();
    const defaultModelRef = resolveDefaultModelForAgent({ cfg, agentId: params.agentId });
    const defaultProvider = defaultModelRef.provider;
    const parsed = parseModelRef(raw, defaultProvider);
    if (!parsed) {
        return { errorMessage: "Invalid `x-openclaw-model`." };
    }
    const catalog = await loadGatewayModelCatalog();
    const allowed = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider,
        agentId: params.agentId,
    });
    const normalized = modelKey(parsed.provider, parsed.model);
    if (!allowed.allowAny && !allowed.allowedKeys.has(normalized)) {
        return {
            errorMessage: `Model '${normalized}' is not allowed for agent '${params.agentId}'.`,
        };
    }
    return { modelOverride: raw };
}
export function resolveAgentIdForRequest(params) {
    const cfg = loadConfig();
    const fromHeader = resolveAgentIdFromHeader(params.req);
    if (fromHeader) {
        return fromHeader;
    }
    const fromModel = resolveAgentIdFromModel(params.model, cfg);
    return fromModel ?? resolveDefaultAgentId(cfg);
}
export function resolveSessionKey(params) {
    const explicit = getHeader(params.req, "x-openclaw-session-key")?.trim();
    if (explicit) {
        return explicit;
    }
    const user = params.user?.trim();
    const mainKey = user ? `${params.prefix}-user:${user}` : `${params.prefix}:${randomUUID()}`;
    return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
}
export function resolveGatewayRequestContext(params) {
    const agentId = resolveAgentIdForRequest({ req: params.req, model: params.model });
    const sessionKey = resolveSessionKey({
        req: params.req,
        agentId,
        user: params.user,
        prefix: params.sessionPrefix,
    });
    const messageChannel = params.useMessageChannelHeader
        ? (normalizeMessageChannel(getHeader(params.req, "x-openclaw-message-channel")) ??
            params.defaultMessageChannel)
        : params.defaultMessageChannel;
    return { agentId, sessionKey, messageChannel };
}
