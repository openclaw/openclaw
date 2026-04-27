import { hasExplicitPluginConfig } from "./config-policy.js";
export function withBundledPluginAllowlistCompat(params) {
    const allow = params.config?.plugins?.allow;
    if (!Array.isArray(allow) || allow.length === 0) {
        return params.config;
    }
    const allowSet = new Set(allow.map((entry) => entry.trim()).filter(Boolean));
    let changed = false;
    for (const pluginId of params.pluginIds) {
        if (!allowSet.has(pluginId)) {
            allowSet.add(pluginId);
            changed = true;
        }
    }
    if (!changed) {
        return params.config;
    }
    return {
        ...params.config,
        plugins: {
            ...params.config?.plugins,
            allow: [...allowSet],
        },
    };
}
export function withBundledPluginEnablementCompat(params) {
    const existingEntries = params.config?.plugins?.entries ?? {};
    const forcePluginsEnabled = params.config?.plugins?.enabled === false;
    let changed = false;
    const nextEntries = { ...existingEntries };
    for (const pluginId of params.pluginIds) {
        if (existingEntries[pluginId] !== undefined) {
            continue;
        }
        nextEntries[pluginId] = { enabled: true };
        changed = true;
    }
    if (!changed) {
        if (!forcePluginsEnabled) {
            return params.config;
        }
    }
    return {
        ...params.config,
        plugins: {
            ...params.config?.plugins,
            ...(forcePluginsEnabled ? { enabled: true } : {}),
            entries: {
                ...existingEntries,
                ...nextEntries,
            },
        },
    };
}
export function withBundledPluginVitestCompat(params) {
    const env = params.env ?? process.env;
    const isVitest = Boolean(env.VITEST);
    if (!isVitest ||
        hasExplicitPluginConfig(params.config?.plugins) ||
        params.pluginIds.length === 0) {
        return params.config;
    }
    const entries = Object.fromEntries(params.pluginIds.map((pluginId) => [pluginId, { enabled: true }]));
    return {
        ...params.config,
        plugins: {
            ...params.config?.plugins,
            enabled: true,
            allow: [...params.pluginIds],
            entries: {
                ...entries,
                ...params.config?.plugins?.entries,
            },
            slots: {
                ...params.config?.plugins?.slots,
                memory: "none",
            },
        },
    };
}
