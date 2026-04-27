import { resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveGatewayCredentialsFromValues } from "./credentials.js";
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
    const tokenRef = resolveSecretInputRef({ value: authConfig.token }).ref;
    const passwordRef = resolveSecretInputRef({ value: authConfig.password }).ref;
    const resolvedCredentials = resolveGatewayCredentialsFromValues({
        configToken: tokenRef ? undefined : authConfig.token,
        configPassword: passwordRef ? undefined : authConfig.password,
        env,
        tokenPrecedence: "config-first",
        passwordPrecedence: "config-first", // pragma: allowlist secret
    });
    const token = resolvedCredentials.token;
    const password = resolvedCredentials.password;
    const trustedProxy = authConfig.trustedProxy;
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
    };
}
export function resolveEffectiveSharedGatewayAuth(params) {
    const resolvedAuth = resolveGatewayAuth(params);
    if (resolvedAuth.mode === "token") {
        return {
            mode: "token",
            secret: resolvedAuth.token,
        };
    }
    if (resolvedAuth.mode === "password") {
        return {
            mode: "password",
            secret: resolvedAuth.password,
        };
    }
    return null;
}
