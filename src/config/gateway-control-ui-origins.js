import { DEFAULT_GATEWAY_PORT } from "./paths.js";
export function isGatewayNonLoopbackBindMode(bind) {
    return bind === "lan" || bind === "tailnet" || bind === "custom" || bind === "auto";
}
export function hasConfiguredControlUiAllowedOrigins(params) {
    if (params.dangerouslyAllowHostHeaderOriginFallback === true) {
        return true;
    }
    return (Array.isArray(params.allowedOrigins) &&
        params.allowedOrigins.some((origin) => typeof origin === "string" && origin.trim().length > 0));
}
export function resolveGatewayPortWithDefault(port, fallback = DEFAULT_GATEWAY_PORT) {
    return typeof port === "number" && port > 0 ? port : fallback;
}
export function buildDefaultControlUiAllowedOrigins(params) {
    const origins = new Set([
        `http://localhost:${params.port}`,
        `http://127.0.0.1:${params.port}`,
    ]);
    const customBindHost = params.customBindHost?.trim();
    if (params.bind === "custom" && customBindHost) {
        origins.add(`http://${customBindHost}:${params.port}`);
    }
    return [...origins];
}
export function ensureControlUiAllowedOriginsForNonLoopbackBind(config, opts) {
    const bind = config.gateway?.bind;
    // When bind is unset (undefined) and we are inside a container, the runtime
    // will default to "auto" → 0.0.0.0 via defaultGatewayBindMode().  We must
    // seed origins *before* resolveGatewayRuntimeConfig runs, otherwise the
    // non-loopback Control UI origin check will hard-fail on startup.
    const effectiveBind = bind ?? (opts?.isContainerEnvironment?.() ? "auto" : undefined);
    if (!isGatewayNonLoopbackBindMode(effectiveBind)) {
        return { config, seededOrigins: null, bind: null };
    }
    if (opts?.requireControlUiEnabled && config.gateway?.controlUi?.enabled === false) {
        return { config, seededOrigins: null, bind: effectiveBind };
    }
    if (hasConfiguredControlUiAllowedOrigins({
        allowedOrigins: config.gateway?.controlUi?.allowedOrigins,
        dangerouslyAllowHostHeaderOriginFallback: config.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback,
    })) {
        return { config, seededOrigins: null, bind: effectiveBind };
    }
    const port = resolveGatewayPortWithDefault(config.gateway?.port, opts?.defaultPort);
    const seededOrigins = buildDefaultControlUiAllowedOrigins({
        port,
        bind: effectiveBind,
        customBindHost: config.gateway?.customBindHost,
    });
    return {
        config: {
            ...config,
            gateway: {
                ...config.gateway,
                controlUi: {
                    ...config.gateway?.controlUi,
                    allowedOrigins: seededOrigins,
                },
            },
        },
        seededOrigins,
        bind: effectiveBind,
    };
}
