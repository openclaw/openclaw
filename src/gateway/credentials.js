export function trimToUndefined(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function firstDefined(values) {
    for (const value of values) {
        if (value) {
            return value;
        }
    }
    return undefined;
}
function readGatewayTokenEnv(env, includeLegacyEnv) {
    const primary = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
    if (primary) {
        return primary;
    }
    if (!includeLegacyEnv) {
        return undefined;
    }
    return trimToUndefined(env.CLAWDBOT_GATEWAY_TOKEN);
}
function readGatewayPasswordEnv(env, includeLegacyEnv) {
    const primary = trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);
    if (primary) {
        return primary;
    }
    if (!includeLegacyEnv) {
        return undefined;
    }
    return trimToUndefined(env.CLAWDBOT_GATEWAY_PASSWORD);
}
export function resolveGatewayCredentialsFromValues(params) {
    const env = params.env ?? process.env;
    const includeLegacyEnv = params.includeLegacyEnv ?? true;
    const envToken = readGatewayTokenEnv(env, includeLegacyEnv);
    const envPassword = readGatewayPasswordEnv(env, includeLegacyEnv);
    const configToken = trimToUndefined(params.configToken);
    const configPassword = trimToUndefined(params.configPassword);
    const tokenPrecedence = params.tokenPrecedence ?? "env-first";
    const passwordPrecedence = params.passwordPrecedence ?? "env-first";
    const token = tokenPrecedence === "config-first"
        ? firstDefined([configToken, envToken])
        : firstDefined([envToken, configToken]);
    const password = passwordPrecedence === "config-first"
        ? firstDefined([configPassword, envPassword])
        : firstDefined([envPassword, configPassword]);
    return { token, password };
}
export function resolveGatewayCredentialsFromConfig(params) {
    const env = params.env ?? process.env;
    const includeLegacyEnv = params.includeLegacyEnv ?? true;
    const explicitToken = trimToUndefined(params.explicitAuth?.token);
    const explicitPassword = trimToUndefined(params.explicitAuth?.password);
    if (explicitToken || explicitPassword) {
        return { token: explicitToken, password: explicitPassword };
    }
    if (trimToUndefined(params.urlOverride)) {
        return {};
    }
    const mode = params.modeOverride ?? (params.cfg.gateway?.mode === "remote" ? "remote" : "local");
    const remote = params.cfg.gateway?.remote;
    const envToken = readGatewayTokenEnv(env, includeLegacyEnv);
    const envPassword = readGatewayPasswordEnv(env, includeLegacyEnv);
    const remoteToken = trimToUndefined(remote?.token);
    const remotePassword = trimToUndefined(remote?.password);
    const localToken = trimToUndefined(params.cfg.gateway?.auth?.token);
    const localPassword = trimToUndefined(params.cfg.gateway?.auth?.password);
    const localTokenPrecedence = params.localTokenPrecedence ?? "env-first";
    const localPasswordPrecedence = params.localPasswordPrecedence ?? "env-first";
    if (mode === "local") {
        // In local mode, prefer gateway.auth.token, but also accept gateway.remote.token
        // as a fallback for cron commands and other local gateway clients.
        // This allows users in remote mode to use a single token for all operations.
        const fallbackToken = localToken ?? remoteToken;
        const fallbackPassword = localPassword ?? remotePassword;
        const localResolved = resolveGatewayCredentialsFromValues({
            configToken: fallbackToken,
            configPassword: fallbackPassword,
            env,
            includeLegacyEnv,
            tokenPrecedence: localTokenPrecedence,
            passwordPrecedence: localPasswordPrecedence,
        });
        return localResolved;
    }
    const remoteTokenFallback = params.remoteTokenFallback ?? "remote-env-local";
    const remotePasswordFallback = params.remotePasswordFallback ?? "remote-env-local";
    const remoteTokenPrecedence = params.remoteTokenPrecedence ?? "remote-first";
    const remotePasswordPrecedence = params.remotePasswordPrecedence ?? "env-first";
    const token = remoteTokenFallback === "remote-only"
        ? remoteToken
        : remoteTokenPrecedence === "env-first"
            ? firstDefined([envToken, remoteToken, localToken])
            : firstDefined([remoteToken, envToken, localToken]);
    const password = remotePasswordFallback === "remote-only"
        ? remotePassword
        : remotePasswordPrecedence === "env-first"
            ? firstDefined([envPassword, remotePassword, localPassword])
            : firstDefined([remotePassword, envPassword, localPassword]);
    return { token, password };
}
