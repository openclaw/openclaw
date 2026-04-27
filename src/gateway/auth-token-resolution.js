import { resolveSecretInputRef } from "../config/types.secrets.js";
import { trimToUndefined } from "./credentials.js";
import { resolveConfiguredSecretInputString, } from "./resolve-configured-secret-input-string.js";
export async function resolveGatewayAuthToken(params) {
    const explicitToken = trimToUndefined(params.explicitToken);
    if (explicitToken) {
        return {
            token: explicitToken,
            source: "explicit",
            secretRefConfigured: false,
        };
    }
    const tokenInput = params.cfg.gateway?.auth?.token;
    const tokenRef = resolveSecretInputRef({
        value: tokenInput,
        defaults: params.cfg.secrets?.defaults,
    }).ref;
    const envFallback = params.envFallback ?? "always";
    const envToken = trimToUndefined(params.env.OPENCLAW_GATEWAY_TOKEN);
    if (!tokenRef) {
        const configToken = trimToUndefined(tokenInput);
        if (configToken) {
            return {
                token: configToken,
                source: "config",
                secretRefConfigured: false,
            };
        }
        if (envFallback !== "never" && envToken) {
            return {
                token: envToken,
                source: "env",
                secretRefConfigured: false,
            };
        }
        return { secretRefConfigured: false };
    }
    const resolved = await resolveConfiguredSecretInputString({
        config: params.cfg,
        env: params.env,
        value: tokenInput,
        path: "gateway.auth.token",
        unresolvedReasonStyle: params.unresolvedReasonStyle,
    });
    if (resolved.value) {
        return {
            token: resolved.value,
            source: "secretRef",
            secretRefConfigured: true,
        };
    }
    if (envFallback === "always" && envToken) {
        return {
            token: envToken,
            source: "env",
            secretRefConfigured: true,
        };
    }
    return {
        secretRefConfigured: true,
        unresolvedRefReason: resolved.unresolvedRefReason,
    };
}
