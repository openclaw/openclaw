import type { IncomingMessage, ServerResponse } from "node:http";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "./auth.js";
import { sendGatewayAuthFailure, sendMissingScopeForbidden } from "./http-common.js";
import { ADMIN_SCOPE, CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";

/** Returns the first HTTP header value after Node lowercases header names. */
export function getHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[normalizeLowercaseStringOrEmpty(name)];
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return undefined;
}

/** Extracts a normalized bearer token from the Authorization header. */
export function getBearerToken(req: IncomingMessage): string | undefined {
  const raw = normalizeOptionalString(getHeader(req, "authorization")) ?? "";
  if (!normalizeLowercaseStringOrEmpty(raw).startsWith("bearer ")) {
    return undefined;
  }
  return normalizeOptionalString(raw.slice(7));
}

type SharedSecretGatewayAuth = Pick<ResolvedGatewayAuth, "mode">;
export type AuthorizedGatewayHttpRequest = {
  /** Auth method accepted for the request, when the underlying auth check reports one. */
  authMethod?: GatewayAuthResult["method"];
  /** Whether operator scopes declared by request headers may be trusted. */
  trustDeclaredOperatorScopes: boolean;
};

export type GatewayHttpRequestAuthCheckResult =
  | {
      /** Request passed Gateway HTTP auth. */
      ok: true;
      /** Auth method and operator-scope trust state for downstream authorization. */
      requestAuth: AuthorizedGatewayHttpRequest;
    }
  | {
      /** Request failed Gateway HTTP auth. */
      ok: false;
      /** Failure details used by callers that write the response themselves. */
      authResult: GatewayAuthResult;
    };

/** Builds the browser-origin policy passed into shared Gateway HTTP auth checks. */
export function resolveHttpBrowserOriginPolicy(
  req: IncomingMessage,
  cfg = getRuntimeConfig(),
): NonNullable<Parameters<typeof authorizeHttpGatewayConnect>[0]["browserOriginPolicy"]> {
  return {
    requestHost: getHeader(req, "host"),
    origin: getHeader(req, "origin"),
    allowedOrigins: cfg.gateway?.controlUi?.allowedOrigins,
    allowHostHeaderOriginFallback:
      cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true,
  };
}

function usesSharedSecretHttpAuth(auth: SharedSecretGatewayAuth | undefined): boolean {
  return auth?.mode === "token" || auth?.mode === "password";
}

function usesSharedSecretGatewayMethod(method: GatewayAuthResult["method"] | undefined): boolean {
  return method === "token" || method === "password";
}

function shouldTrustDeclaredHttpOperatorScopes(
  req: IncomingMessage,
  authOrRequest:
    | SharedSecretGatewayAuth
    | Pick<AuthorizedGatewayHttpRequest, "trustDeclaredOperatorScopes">
    | undefined,
): boolean {
  if (authOrRequest && "trustDeclaredOperatorScopes" in authOrRequest) {
    return authOrRequest.trustDeclaredOperatorScopes;
  }
  // Callers that pass only auth config get the conservative legacy check:
  // bearer shared-secret requests cannot self-declare narrower operator scopes.
  return !isGatewayBearerHttpRequest(req, authOrRequest);
}

/** Authorizes an HTTP request or writes the Gateway auth failure response. */
export async function authorizeGatewayHttpRequestOrReply(params: {
  /** Incoming HTTP request to authenticate. */
  req: IncomingMessage;
  /** Response used when auth fails. */
  res: ServerResponse;
  /** Resolved Gateway auth policy. */
  auth: ResolvedGatewayAuth;
  /** Trusted proxy CIDRs/hosts used for forwarded-origin checks. */
  trustedProxies?: string[];
  /** Whether direct remote addresses may be used when proxy headers are absent. */
  allowRealIpFallback?: boolean;
  /** Optional auth failure budget shared with the Gateway HTTP layer. */
  rateLimiter?: AuthRateLimiter;
}): Promise<AuthorizedGatewayHttpRequest | null> {
  const result = await checkGatewayHttpRequestAuth(params);
  if (!result.ok) {
    sendGatewayAuthFailure(params.res, result.authResult);
    return null;
  }
  return result.requestAuth;
}

/** Runs Gateway HTTP auth and returns structured auth/trust state without writing a response. */
export async function checkGatewayHttpRequestAuth(params: {
  /** Incoming HTTP request to authenticate. */
  req: IncomingMessage;
  /** Resolved Gateway auth policy. */
  auth: ResolvedGatewayAuth;
  /** Trusted proxy CIDRs/hosts used for forwarded-origin checks. */
  trustedProxies?: string[];
  /** Whether direct remote addresses may be used when proxy headers are absent. */
  allowRealIpFallback?: boolean;
  /** Optional auth failure budget shared with the Gateway HTTP layer. */
  rateLimiter?: AuthRateLimiter;
  /** Config snapshot used for browser-origin policy resolution. */
  cfg?: OpenClawConfig;
}): Promise<GatewayHttpRequestAuthCheckResult> {
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

/** Authorizes HTTP auth plus a required operator method scope, writing failures to the response. */
export async function authorizeScopedGatewayHttpRequestOrReply(params: {
  /** Incoming HTTP request to authenticate and authorize. */
  req: IncomingMessage;
  /** Response used when auth or scope checks fail. */
  res: ServerResponse;
  /** Resolved Gateway auth policy. */
  auth: ResolvedGatewayAuth;
  /** Trusted proxy CIDRs/hosts used for forwarded-origin checks. */
  trustedProxies?: string[];
  /** Whether direct remote addresses may be used when proxy headers are absent. */
  allowRealIpFallback?: boolean;
  /** Optional auth failure budget shared with the Gateway HTTP layer. */
  rateLimiter?: AuthRateLimiter;
  /** Gateway method whose operator scopes gate this endpoint. */
  operatorMethod: string;
  /** Resolves the trusted operator scopes after request authentication. */
  resolveOperatorScopes: (
    req: IncomingMessage,
    requestAuth: AuthorizedGatewayHttpRequest,
  ) => string[];
}): Promise<{
  cfg: OpenClawConfig;
  requestAuth: AuthorizedGatewayHttpRequest;
  operatorScopes: string[];
} | null> {
  const cfg = getRuntimeConfig();
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

  // Scope resolution happens after auth so resolvers can distinguish trusted
  // proxy/local requests from shared-secret bearer requests.
  const operatorScopes = params.resolveOperatorScopes(params.req, requestAuth);
  const scopeAuth = authorizeOperatorScopesForMethod(params.operatorMethod, operatorScopes);
  if (!scopeAuth.allowed) {
    sendMissingScopeForbidden(params.res, scopeAuth.missingScope);
    return null;
  }

  return { cfg, requestAuth, operatorScopes };
}

/** Returns true when the request uses shared-secret bearer auth for this Gateway auth config. */
export function isGatewayBearerHttpRequest(
  req: IncomingMessage,
  auth?: SharedSecretGatewayAuth,
): boolean {
  return usesSharedSecretHttpAuth(auth) && Boolean(getBearerToken(req));
}

/** Resolves trusted operator scopes from headers, defaulting only on trusted request surfaces. */
export function resolveTrustedHttpOperatorScopes(
  req: IncomingMessage,
  authOrRequest?:
    | SharedSecretGatewayAuth
    | Pick<AuthorizedGatewayHttpRequest, "trustDeclaredOperatorScopes">,
): string[] {
  if (!shouldTrustDeclaredHttpOperatorScopes(req, authOrRequest)) {
    // Gateway bearer auth only proves possession of the shared secret. Do not
    // let HTTP clients self-assert operator scopes through request headers.
    return [];
  }

  const headerValue = getHeader(req, "x-openclaw-scopes");
  if (headerValue === undefined) {
    // No scope header present - trusted clients without an explicit header
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

/** Scope resolver for OpenAI-compatible HTTP routes that opt into shared-secret trust. */
export function resolveOpenAiCompatibleHttpOperatorScopes(
  req: IncomingMessage,
  requestAuth: AuthorizedGatewayHttpRequest,
): string[] {
  return resolveSharedSecretHttpOperatorScopes(req, requestAuth);
}

/** Restores default operator scopes for shared-secret HTTP surfaces that explicitly trust them. */
export function resolveSharedSecretHttpOperatorScopes(
  req: IncomingMessage,
  requestAuth: AuthorizedGatewayHttpRequest,
): string[] {
  if (usesSharedSecretGatewayMethod(requestAuth.authMethod)) {
    // Shared-secret HTTP bearer auth is a documented trusted-operator surface
    // for direct HTTP surfaces that opt into it. This is designed-as-is:
    // token/password auth proves possession of the gateway operator secret, not
    // a narrower per-request scope identity, so restore the normal defaults.
    return [...CLI_DEFAULT_OPERATOR_SCOPES];
  }
  return resolveTrustedHttpOperatorScopes(req, requestAuth);
}

/** Returns whether the trusted HTTP scope set carries owner/admin semantics. */
export function resolveHttpSenderIsOwner(
  req: IncomingMessage,
  authOrRequest?:
    | SharedSecretGatewayAuth
    | Pick<AuthorizedGatewayHttpRequest, "trustDeclaredOperatorScopes">,
): boolean {
  return resolveTrustedHttpOperatorScopes(req, authOrRequest).includes(ADMIN_SCOPE);
}

/** Owner resolver for OpenAI-compatible HTTP routes with shared-secret owner semantics. */
export function resolveOpenAiCompatibleHttpSenderIsOwner(
  req: IncomingMessage,
  requestAuth: AuthorizedGatewayHttpRequest,
): boolean {
  if (usesSharedSecretGatewayMethod(requestAuth.authMethod)) {
    // Shared-secret HTTP bearer auth also carries owner semantics on the compat
    // APIs and direct /tools/invoke. This is intentional: there is no separate
    // per-request owner primitive on that shared-secret path, so managed
    // attachment ownership follows the documented trusted-operator contract.
    return true;
  }
  return resolveHttpSenderIsOwner(req, requestAuth);
}
