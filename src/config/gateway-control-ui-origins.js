import { DEFAULT_GATEWAY_PORT } from "./paths.js";
export function isGatewayNonLoopbackBindMode(bind) {
    return bind === "lan" || bind === "tailnet" || bind === "custom";
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
    if (!isGatewayNonLoopbackBindMode(bind)) {
        return { config, seededOrigins: null, bind: null };
    }
    if (opts?.requireControlUiEnabled && config.gateway?.controlUi?.enabled === false) {
        return { config, seededOrigins: null, bind };
    }
    if (hasConfiguredControlUiAllowedOrigins({
        allowedOrigins: config.gateway?.controlUi?.allowedOrigins,
        dangerouslyAllowHostHeaderOriginFallback: config.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback,
    })) {
        return { config, seededOrigins: null, bind };
    }
    const port = resolveGatewayPortWithDefault(config.gateway?.port, opts?.defaultPort);
    const seededOrigins = buildDefaultControlUiAllowedOrigins({
        port,
        bind,
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
        bind,
    };
}
