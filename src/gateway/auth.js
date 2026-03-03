import { readTailscaleWhoisIdentity } from "../infra/tailscale.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET, } from "./auth-rate-limit.js";
import { resolveGatewayCredentialsFromValues } from "./credentials.js";
import { isLocalishHost, isLoopbackAddress, isTrustedProxyAddress, resolveClientIp, } from "./net.js";
function normalizeLogin(login) {
    return login.trim().toLowerCase();
}
function headerValue(value) {
    return Array.isArray(value) ? value[0] : value;
}
const TAILSCALE_TRUSTED_PROXIES = ["127.0.0.1", "::1"];
function resolveTailscaleClientIp(req) {
    if (!req) {
        return undefined;
    }
    return resolveClientIp({
        remoteAddr: req.socket?.remoteAddress ?? "",
        forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
        trustedProxies: [...TAILSCALE_TRUSTED_PROXIES],
    });
}
function resolveRequestClientIp(req, trustedProxies, allowRealIpFallback = false) {
    if (!req) {
        return undefined;
    }
    return resolveClientIp({
        remoteAddr: req.socket?.remoteAddress ?? "",
        forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
        realIp: headerValue(req.headers?.["x-real-ip"]),
        trustedProxies,
        allowRealIpFallback,
    });
}
export function isLocalDirectRequest(req, trustedProxies, allowRealIpFallback = false) {
    if (!req) {
        return false;
    }
    const clientIp = resolveRequestClientIp(req, trustedProxies, allowRealIpFallback) ?? "";
    if (!isLoopbackAddress(clientIp)) {
        return false;
    }
    const hasForwarded = Boolean(req.headers?.["x-forwarded-for"] ||
        req.headers?.["x-real-ip"] ||
        req.headers?.["x-forwarded-host"]);
    const remoteIsTrustedProxy = isTrustedProxyAddress(req.socket?.remoteAddress, trustedProxies);
    return isLocalishHost(req.headers?.host) && (!hasForwarded || remoteIsTrustedProxy);
}
function getTailscaleUser(req) {
    if (!req) {
        return null;
    }
    const login = req.headers["tailscale-user-login"];
    if (typeof login !== "string" || !login.trim()) {
        return null;
    }
    const nameRaw = req.headers["tailscale-user-name"];
    const profilePic = req.headers["tailscale-user-profile-pic"];
    const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : login.trim();
    return {
        login: login.trim(),
        name,
        profilePic: typeof profilePic === "string" && profilePic.trim() ? profilePic.trim() : undefined,
    };
}
function hasTailscaleProxyHeaders(req) {
    if (!req) {
        return false;
    }
    return Boolean(req.headers["x-forwarded-for"] &&
        req.headers["x-forwarded-proto"] &&
        req.headers["x-forwarded-host"]);
}
function isTailscaleProxyRequest(req) {
    if (!req) {
        return false;
    }
    return isLoopbackAddress(req.socket?.remoteAddress) && hasTailscaleProxyHeaders(req);
}
async function resolveVerifiedTailscaleUser(params) {
    const { req, tailscaleWhois } = params;
    const tailscaleUser = getTailscaleUser(req);
    if (!tailscaleUser) {
        return { ok: false, reason: "tailscale_user_missing" };
    }
    if (!isTailscaleProxyRequest(req)) {
        return { ok: false, reason: "tailscale_proxy_missing" };
    }
    const clientIp = resolveTailscaleClientIp(req);
    if (!clientIp) {
        return { ok: false, reason: "tailscale_whois_failed" };
    }
    const whois = await tailscaleWhois(clientIp);
    if (!whois?.login) {
        return { ok: false, reason: "tailscale_whois_failed" };
    }
    if (normalizeLogin(whois.login) !== normalizeLogin(tailscaleUser.login)) {
        return { ok: false, reason: "tailscale_user_mismatch" };
    }
    return {
        ok: true,
        user: {
            login: whois.login,
            name: whois.name ?? tailscaleUser.name,
            profilePic: tailscaleUser.profilePic,
        },
    };
}
export function resolveGatewayAuth(params) {
    const baseAuthConfig = params.authConfig ?? {};
    const authOverride = params.authOverride ?? undefined;
    const authConfig = { ...baseAuthConfig };
    if (authOverride) {
        if (authOverride.mode !== undefined) {
            authConfig.mode = authOverride.mode;
        }
        if (authOverride.token !== undefined) {
            authConfig.token = authOverride.token;
        }
        if (authOverride.password !== undefined) {
            authConfig.password = authOverride.password;
        }
        if (authOverride.allowTailscale !== undefined) {
            authConfig.allowTailscale = authOverride.allowTailscale;
        }
        if (authOverride.rateLimit !== undefined) {
            authConfig.rateLimit = authOverride.rateLimit;
        }
        if (authOverride.trustedProxy !== undefined) {
            authConfig.trustedProxy = authOverride.trustedProxy;
        }
    }
    const env = params.env ?? process.env;
    const resolvedCredentials = resolveGatewayCredentialsFromValues({
        configToken: authConfig.token,
        configPassword: authConfig.password,
        env,
        includeLegacyEnv: false,
        tokenPrecedence: "config-first",
        passwordPrecedence: "config-first",
    });
    const token = resolvedCredentials.token;
    const password = resolvedCredentials.password;
    const trustedProxy = authConfig.trustedProxy;
    const whitelist = authConfig.whitelist;
    let mode;
    let modeSource;
    if (authOverride?.mode !== undefined) {
        mode = authOverride.mode;
        modeSource = "override";
    }
    else if (authConfig.mode) {
        mode = authConfig.mode;
        modeSource = "config";
    }
    else if (password) {
        mode = "password";
        modeSource = "password";
    }
    else if (token) {
        mode = "token";
        modeSource = "token";
    }
    else {
        mode = "token";
        modeSource = "default";
    }
    const allowTailscale = authConfig.allowTailscale ??
        (params.tailscaleMode === "serve" && mode !== "password" && mode !== "trusted-proxy");
    return {
        mode,
        modeSource,
        token,
        password,
        allowTailscale,
        trustedProxy,
        whitelist,
    };
}
export function assertGatewayAuthConfigured(auth) {
    if (auth.mode === "token" && !auth.token) {
        if (auth.allowTailscale) {
            return;
        }
        throw new Error("gateway auth mode is token, but no token was configured (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)");
    }
    if (auth.mode === "password" && !auth.password) {
        throw new Error("gateway auth mode is password, but no password was configured");
    }
    if (auth.mode === "trusted-proxy") {
        if (!auth.trustedProxy) {
            throw new Error("gateway auth mode is trusted-proxy, but no trustedProxy config was provided (set gateway.auth.trustedProxy)");
        }
        if (!auth.trustedProxy.userHeader || auth.trustedProxy.userHeader.trim() === "") {
            throw new Error("gateway auth mode is trusted-proxy, but trustedProxy.userHeader is empty (set gateway.auth.trustedProxy.userHeader)");
        }
    }
}
/**
 * Check if the request came from a trusted proxy and extract user identity.
 * Returns the user identity if valid, or null with a reason if not.
 */
function authorizeTrustedProxy(params) {
    const { req, trustedProxies, trustedProxyConfig } = params;
    if (!req) {
        return { reason: "trusted_proxy_no_request" };
    }
    const remoteAddr = req.socket?.remoteAddress;
    if (!remoteAddr || !isTrustedProxyAddress(remoteAddr, trustedProxies)) {
        return { reason: "trusted_proxy_untrusted_source" };
    }
    const requiredHeaders = trustedProxyConfig.requiredHeaders ?? [];
    for (const header of requiredHeaders) {
        const value = headerValue(req.headers[header.toLowerCase()]);
        if (!value || value.trim() === "") {
            return { reason: `trusted_proxy_missing_header_${header}` };
        }
    }
    const userHeaderValue = headerValue(req.headers[trustedProxyConfig.userHeader.toLowerCase()]);
    if (!userHeaderValue || userHeaderValue.trim() === "") {
        return { reason: "trusted_proxy_user_missing" };
    }
    const user = userHeaderValue.trim();
    const allowUsers = trustedProxyConfig.allowUsers ?? [];
    if (allowUsers.length > 0 && !allowUsers.includes(user)) {
        return { reason: "trusted_proxy_user_not_allowed" };
    }
    return { user };
}
function shouldAllowTailscaleHeaderAuth(authSurface) {
    return authSurface === "ws-control-ui";
}
export async function authorizeGatewayConnect(params) {
    const { auth, connectAuth, req, trustedProxies } = params;
    const tailscaleWhois = params.tailscaleWhois ?? readTailscaleWhoisIdentity;
    const authSurface = params.authSurface ?? "http";
    const allowTailscaleHeaderAuth = shouldAllowTailscaleHeaderAuth(authSurface);
    const localDirect = isLocalDirectRequest(req, trustedProxies, params.allowRealIpFallback === true);
    if (auth.mode === "trusted-proxy") {
        if (!auth.trustedProxy) {
            return { ok: false, reason: "trusted_proxy_config_missing" };
        }
        if (!trustedProxies || trustedProxies.length === 0) {
            return { ok: false, reason: "trusted_proxy_no_proxies_configured" };
        }
        const result = authorizeTrustedProxy({
            req,
            trustedProxies,
            trustedProxyConfig: auth.trustedProxy,
        });
        if ("user" in result) {
            return { ok: true, method: "trusted-proxy", user: result.user };
        }
        return { ok: false, reason: result.reason };
    }
    if (auth.mode === "none") {
        return { ok: true, method: "none" };
    }
    const limiter = params.rateLimiter;
    const ip = params.clientIp ??
        resolveRequestClientIp(req, trustedProxies, params.allowRealIpFallback === true) ??
        req?.socket?.remoteAddress;
    const rateLimitScope = params.rateLimitScope ?? AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET;
    if (limiter) {
        const rlCheck = limiter.check(ip, rateLimitScope);
        if (!rlCheck.allowed) {
            return {
                ok: false,
                reason: "rate_limited",
                rateLimited: true,
                retryAfterMs: rlCheck.retryAfterMs,
            };
        }
    }
    if (allowTailscaleHeaderAuth && auth.allowTailscale && !localDirect) {
        const tailscaleCheck = await resolveVerifiedTailscaleUser({
            req,
            tailscaleWhois,
        });
        if (tailscaleCheck.ok) {
            limiter?.reset(ip, rateLimitScope);
            return {
                ok: true,
                method: "tailscale",
                user: tailscaleCheck.user.login,
            };
        }
    }
    if (auth.mode === "token") {
        if (!auth.token) {
            return { ok: false, reason: "token_missing_config" };
        }
        if (!connectAuth?.token) {
            limiter?.recordFailure(ip, rateLimitScope);
            return { ok: false, reason: "token_missing" };
        }
        if (!safeEqualSecret(connectAuth.token, auth.token)) {
            limiter?.recordFailure(ip, rateLimitScope);
            return { ok: false, reason: "token_mismatch" };
        }
        limiter?.reset(ip, rateLimitScope);
        return { ok: true, method: "token" };
    }
    if (auth.mode === "password") {
        const password = connectAuth?.password;
        if (!auth.password) {
            return { ok: false, reason: "password_missing_config" };
        }
        if (!password) {
            limiter?.recordFailure(ip, rateLimitScope);
            return { ok: false, reason: "password_missing" };
        }
        if (!safeEqualSecret(password, auth.password)) {
            limiter?.recordFailure(ip, rateLimitScope);
            return { ok: false, reason: "password_mismatch" };
        }
        limiter?.reset(ip, rateLimitScope);
        return { ok: true, method: "password" };
    }
    limiter?.recordFailure(ip, rateLimitScope);
    return { ok: false, reason: "unauthorized" };
}
export async function authorizeHttpGatewayConnect(params) {
    return authorizeGatewayConnect({
        ...params,
        authSurface: "http",
    });
}
export async function authorizeWsControlUiGatewayConnect(params) {
    return authorizeGatewayConnect({
        ...params,
        authSurface: "ws-control-ui",
    });
}
