import { resolveProviderAuthAliasMap } from "../agents/provider-auth-aliases.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { isWorkspacePluginAllowedByConfig, normalizePluginConfigId, } from "../plugins/plugin-config-trust.js";
import { hasKind } from "../plugins/slots.js";
const CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES = {
    anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    openai: ["OPENAI_API_KEY"],
    voyage: ["VOYAGE_API_KEY"],
    cerebras: ["CEREBRAS_API_KEY"],
    "anthropic-openai": ["ANTHROPIC_API_KEY"],
    "qwen-dashscope": ["DASHSCOPE_API_KEY"],
};
const CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES = {
    minimax: ["MINIMAX_API_KEY"],
    "minimax-cn": ["MINIMAX_API_KEY"],
};
function isWorkspacePluginTrustedForProviderEnvVars(plugin, config) {
    return isWorkspacePluginAllowedByConfig({
        config,
        isImplicitlyAllowed: (pluginId) => hasKind(plugin.kind, "context-engine") &&
            normalizePluginConfigId(config?.plugins?.slots?.contextEngine) === pluginId,
        plugin,
    });
}
function shouldUsePluginProviderEnvVars(plugin, params) {
    if (plugin.origin !== "workspace" || params?.includeUntrustedWorkspacePlugins !== false) {
        return true;
    }
    return isWorkspacePluginTrustedForProviderEnvVars(plugin, params?.config);
}
function appendUniqueEnvVarCandidates(target, providerId, keys) {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId || keys.length === 0) {
        return;
    }
    const bucket = (target[normalizedProviderId] ??= []);
    const seen = new Set(bucket);
    for (const key of keys) {
        const normalizedKey = key.trim();
        if (!normalizedKey || seen.has(normalizedKey)) {
            continue;
        }
        seen.add(normalizedKey);
        bucket.push(normalizedKey);
    }
}
function resolveManifestProviderAuthEnvVarCandidates(params) {
    const registry = loadPluginManifestRegistry({
        config: params?.config,
        workspaceDir: params?.workspaceDir,
        env: params?.env,
    });
    const candidates = {};
    for (const plugin of registry.plugins) {
        if (!shouldUsePluginProviderEnvVars(plugin, params)) {
            continue;
        }
        if (plugin.providerAuthEnvVars) {
            for (const [providerId, keys] of Object.entries(plugin.providerAuthEnvVars).toSorted(([left], [right]) => left.localeCompare(right))) {
                appendUniqueEnvVarCandidates(candidates, providerId, keys);
            }
        }
        for (const provider of plugin.setup?.providers ?? []) {
            appendUniqueEnvVarCandidates(candidates, provider.id, provider.envVars ?? []);
        }
    }
    const aliases = resolveProviderAuthAliasMap(params);
    for (const [alias, target] of Object.entries(aliases).toSorted(([left], [right]) => left.localeCompare(right))) {
        const keys = candidates[target];
        if (keys) {
            appendUniqueEnvVarCandidates(candidates, alias, keys);
        }
    }
    return candidates;
}
export function resolveProviderAuthEnvVarCandidates(params) {
    return {
        ...resolveManifestProviderAuthEnvVarCandidates(params),
        ...CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES,
    };
}
export function resolveProviderEnvVars(params) {
    return {
        ...resolveProviderAuthEnvVarCandidates(params),
        ...CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES,
    };
}
const lazyRecordCacheResetters = new Set();
function createLazyReadonlyRecord(resolve) {
    let cached;
    lazyRecordCacheResetters.add(() => {
        cached = undefined;
    });
    const getResolved = () => {
        cached ??= resolve();
        return cached;
    };
    return new Proxy({}, {
        get(_target, prop) {
            if (typeof prop !== "string") {
                return undefined;
            }
            return getResolved()[prop];
        },
        has(_target, prop) {
            return typeof prop === "string" && Object.hasOwn(getResolved(), prop);
        },
        ownKeys() {
            return Reflect.ownKeys(getResolved());
        },
        getOwnPropertyDescriptor(_target, prop) {
            if (typeof prop !== "string") {
                return undefined;
            }
            const value = getResolved()[prop];
            if (value === undefined) {
                return undefined;
            }
            return {
                configurable: true,
                enumerable: true,
                value,
                writable: false,
            };
        },
    });
}
/**
 * Provider auth env candidates used by generic auth resolution.
 *
 * Order matters: the first non-empty value wins for helpers such as
 * `resolveEnvApiKey()`. Bundled providers source this from plugin manifest
 * metadata so auth probes do not need to load plugin runtime.
 */
export const PROVIDER_AUTH_ENV_VAR_CANDIDATES = createLazyReadonlyRecord(() => resolveProviderAuthEnvVarCandidates());
/**
 * Provider env vars used for setup/default secret refs and broad secret
 * scrubbing. This can include non-model providers and may intentionally choose
 * a different preferred first env var than auth resolution.
 *
 * Bundled provider auth envs come from plugin manifests. The override map here
 * is only for true core/non-plugin providers and a few setup-specific ordering
 * overrides where generic onboarding wants a different preferred env var.
 */
export const PROVIDER_ENV_VARS = createLazyReadonlyRecord(() => resolveProviderEnvVars());
export const __testing = {
    resetProviderEnvVarCachesForTests() {
        for (const reset of lazyRecordCacheResetters) {
            reset();
        }
    },
};
export function getProviderEnvVars(providerId, params) {
    const providerEnvVars = params ? resolveProviderEnvVars(params) : PROVIDER_ENV_VARS;
    const envVars = Object.hasOwn(providerEnvVars, providerId)
        ? providerEnvVars[providerId]
        : undefined;
    return Array.isArray(envVars) ? [...envVars] : [];
}
// OPENCLAW_API_KEY authenticates the local OpenClaw bridge itself and must
// remain available to child bridge/runtime processes.
export function listKnownProviderAuthEnvVarNames(params) {
    return [
        ...new Set([
            ...Object.values(resolveProviderAuthEnvVarCandidates(params)).flatMap((keys) => keys),
            ...Object.values(resolveProviderEnvVars(params)).flatMap((keys) => keys),
        ]),
    ];
}
export function listKnownSecretEnvVarNames(params) {
    return [...new Set(Object.values(resolveProviderEnvVars(params)).flatMap((keys) => keys))];
}
export function omitEnvKeysCaseInsensitive(baseEnv, keys) {
    const env = { ...baseEnv };
    const denied = new Set();
    for (const key of keys) {
        const normalizedKey = key.trim();
        if (normalizedKey) {
            denied.add(normalizedKey.toUpperCase());
        }
    }
    if (denied.size === 0) {
        return env;
    }
    for (const actualKey of Object.keys(env)) {
        if (denied.has(actualKey.toUpperCase())) {
            delete env[actualKey];
        }
    }
    return env;
}
