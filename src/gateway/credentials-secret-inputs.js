import { resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveSecretInputString } from "../secrets/resolve-secret-input-string.js";
import { GatewaySecretRefUnavailableError, resolveGatewayCredentialsFromConfig, trimToUndefined, } from "./credentials.js";
import { ALL_GATEWAY_SECRET_INPUT_PATHS, assignResolvedGatewaySecretInput, isSupportedGatewaySecretInputPath, isTokenGatewaySecretInputPath, readGatewaySecretInputValue, } from "./secret-input-paths.js";
function resolveExplicitGatewayAuth(opts) {
    const token = typeof opts?.token === "string" && opts.token.trim().length > 0 ? opts.token.trim() : undefined;
    const password = typeof opts?.password === "string" && opts.password.trim().length > 0
        ? opts.password.trim()
        : undefined;
    return { token, password };
}
async function resolveGatewaySecretInputString(params) {
    const value = await resolveSecretInputString({
        config: params.config,
        value: params.value,
        env: params.env,
        normalize: trimToUndefined,
        onResolveRefError: () => {
            throw new GatewaySecretRefUnavailableError(params.path);
        },
    });
    if (!value) {
        throw new Error(`${params.path} resolved to an empty or non-string value.`);
    }
    return value;
}
function hasConfiguredGatewaySecretRef(config, path) {
    return Boolean(resolveSecretInputRef({
        value: readGatewaySecretInputValue(config, path),
        defaults: config.secrets?.defaults,
    }).ref);
}
function resolveGatewayCredentialsFromConfigOptions(params) {
    const { cfg, env, options } = params;
    return {
        cfg,
        env,
        explicitAuth: options.explicitAuth,
        urlOverride: options.urlOverride,
        urlOverrideSource: options.urlOverrideSource,
        modeOverride: options.modeOverride,
        localTokenPrecedence: options.localTokenPrecedence,
        localPasswordPrecedence: options.localPasswordPrecedence,
        remoteTokenPrecedence: options.remoteTokenPrecedence,
        remotePasswordPrecedence: options.remotePasswordPrecedence ?? "env-first", // pragma: allowlist secret
        remoteTokenFallback: options.remoteTokenFallback,
        remotePasswordFallback: options.remotePasswordFallback,
    };
}
function localAuthModeAllowsGatewaySecretInputPath(params) {
    const { authMode, path } = params;
    if (authMode === "none" || authMode === "trusted-proxy") {
        return false;
    }
    if (authMode === "token") {
        return isTokenGatewaySecretInputPath(path);
    }
    if (authMode === "password") {
        return !isTokenGatewaySecretInputPath(path);
    }
    return true;
}
function gatewaySecretInputPathCanWin(params) {
    if (!hasConfiguredGatewaySecretRef(params.config, params.path)) {
        return false;
    }
    const mode = params.options.modeOverride ?? (params.config.gateway?.mode === "remote" ? "remote" : "local");
    if (mode === "local" &&
        !localAuthModeAllowsGatewaySecretInputPath({
            authMode: params.config.gateway?.auth?.mode,
            path: params.path,
        })) {
        return false;
    }
    const sentinel = `__OPENCLAW_GATEWAY_SECRET_REF_PROBE_${params.path.replaceAll(".", "_")}__`;
    const probeConfig = structuredClone(params.config);
    for (const candidatePath of ALL_GATEWAY_SECRET_INPUT_PATHS) {
        if (!hasConfiguredGatewaySecretRef(probeConfig, candidatePath)) {
            continue;
        }
        assignResolvedGatewaySecretInput({
            config: probeConfig,
            path: candidatePath,
            value: undefined,
        });
    }
    assignResolvedGatewaySecretInput({
        config: probeConfig,
        path: params.path,
        value: sentinel,
    });
    try {
        const resolved = resolveGatewayCredentialsFromConfig(resolveGatewayCredentialsFromConfigOptions({
            cfg: probeConfig,
            env: params.env,
            options: params.options,
        }));
        const tokenCanWin = resolved.token === sentinel && !resolved.password;
        const passwordCanWin = resolved.password === sentinel && !resolved.token;
        return tokenCanWin || passwordCanWin;
    }
    catch {
        return false;
    }
}
async function resolveConfiguredGatewaySecretInput(params) {
    return resolveGatewaySecretInputString({
        config: params.config,
        value: readGatewaySecretInputValue(params.config, params.path),
        path: params.path,
        env: params.env,
    });
}
async function resolvePreferredGatewaySecretInputs(params) {
    let nextConfig = params.config;
    for (const path of ALL_GATEWAY_SECRET_INPUT_PATHS) {
        if (!gatewaySecretInputPathCanWin({
            options: params.options,
            env: params.env,
            config: nextConfig,
            path,
        })) {
            continue;
        }
        if (nextConfig === params.config) {
            nextConfig = structuredClone(params.config);
        }
        try {
            const resolvedValue = await resolveConfiguredGatewaySecretInput({
                config: nextConfig,
                path,
                env: params.env,
            });
            assignResolvedGatewaySecretInput({
                config: nextConfig,
                path,
                value: resolvedValue,
            });
        }
        catch {
            // Keep scanning candidate paths so unresolved higher-priority refs do not
            // prevent valid fallback refs from being considered.
            continue;
        }
    }
    return nextConfig;
}
async function resolveGatewayCredentialsFromConfigWithSecretInputs(params) {
    let resolvedConfig = await resolvePreferredGatewaySecretInputs({
        options: params.options,
        env: params.env,
        config: params.options.config,
    });
    const resolvedPaths = new Set();
    for (;;) {
        try {
            return resolveGatewayCredentialsFromConfig(resolveGatewayCredentialsFromConfigOptions({
                cfg: resolvedConfig,
                env: params.env,
                options: params.options,
            }));
        }
        catch (error) {
            if (!(error instanceof GatewaySecretRefUnavailableError)) {
                throw error;
            }
            const path = error.path;
            if (!isSupportedGatewaySecretInputPath(path) || resolvedPaths.has(path)) {
                throw error;
            }
            if (resolvedConfig === params.options.config) {
                resolvedConfig = structuredClone(params.options.config);
            }
            const resolvedValue = await resolveConfiguredGatewaySecretInput({
                config: resolvedConfig,
                path,
                env: params.env,
            });
            assignResolvedGatewaySecretInput({
                config: resolvedConfig,
                path,
                value: resolvedValue,
            });
            resolvedPaths.add(path);
        }
    }
}
export async function resolveGatewayCredentialsWithSecretInputs(params) {
    const options = {
        ...params,
        explicitAuth: resolveExplicitGatewayAuth(params.explicitAuth),
    };
    if (options.explicitAuth.token || options.explicitAuth.password) {
        return {
            token: options.explicitAuth.token,
            password: options.explicitAuth.password,
        };
    }
    return await resolveGatewayCredentialsFromConfigWithSecretInputs({
        options,
        env: params.env ?? process.env,
    });
}
