import { normalizeProviderId } from "../agents/model-selection.js";
import { getChannelPluginCatalogEntry, listChannelPluginCatalogEntries, } from "../channels/plugins/catalog.js";
import { getChatChannelMeta, listChatChannels, normalizeChatChannelId, } from "../channels/registry.js";
import { loadPluginManifestRegistry, } from "../plugins/manifest-registry.js";
import { isRecord } from "../utils.js";
import { hasAnyWhatsAppAuth } from "../web/accounts.js";
import { ensurePluginAllowlisted } from "./plugins-allowlist.js";
const CHANNEL_PLUGIN_IDS = Array.from(new Set([
    ...listChatChannels().map((meta) => meta.id),
    ...listChannelPluginCatalogEntries().map((entry) => entry.id),
]));
const PROVIDER_PLUGIN_IDS = [
    { pluginId: "google-gemini-cli-auth", providerId: "google-gemini-cli" },
    { pluginId: "qwen-portal-auth", providerId: "qwen-portal" },
    { pluginId: "copilot-proxy", providerId: "copilot-proxy" },
    { pluginId: "minimax-portal-auth", providerId: "minimax-portal" },
];
function hasNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function recordHasKeys(value) {
    return isRecord(value) && Object.keys(value).length > 0;
}
function accountsHaveKeys(value, keys) {
    if (!isRecord(value)) {
        return false;
    }
    for (const account of Object.values(value)) {
        if (!isRecord(account)) {
            continue;
        }
        for (const key of keys) {
            if (hasNonEmptyString(account[key])) {
                return true;
            }
        }
    }
    return false;
}
function resolveChannelConfig(cfg, channelId) {
    const channels = cfg.channels;
    const entry = channels?.[channelId];
    return isRecord(entry) ? entry : null;
}
const STRUCTURED_CHANNEL_CONFIG_SPECS = {
    telegram: {
        envAny: ["TELEGRAM_BOT_TOKEN"],
        stringKeys: ["botToken", "tokenFile"],
        accountStringKeys: ["botToken", "tokenFile"],
    },
    discord: {
        envAny: ["DISCORD_BOT_TOKEN"],
        stringKeys: ["token"],
        accountStringKeys: ["token"],
    },
    irc: {
        envAll: ["IRC_HOST", "IRC_NICK"],
        stringKeys: ["host", "nick"],
        accountStringKeys: ["host", "nick"],
    },
    slack: {
        envAny: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_TOKEN"],
        stringKeys: ["botToken", "appToken", "userToken"],
        accountStringKeys: ["botToken", "appToken", "userToken"],
    },
    signal: {
        stringKeys: ["account", "httpUrl", "httpHost", "cliPath"],
        numberKeys: ["httpPort"],
        accountStringKeys: ["account", "httpUrl", "httpHost", "cliPath"],
    },
    imessage: {
        stringKeys: ["cliPath"],
    },
};
function envHasAnyKeys(env, keys) {
    for (const key of keys) {
        if (hasNonEmptyString(env[key])) {
            return true;
        }
    }
    return false;
}
function envHasAllKeys(env, keys) {
    for (const key of keys) {
        if (!hasNonEmptyString(env[key])) {
            return false;
        }
    }
    return keys.length > 0;
}
function hasAnyNumberKeys(entry, keys) {
    for (const key of keys) {
        if (typeof entry[key] === "number") {
            return true;
        }
    }
    return false;
}
function isStructuredChannelConfigured(cfg, channelId, env, spec) {
    if (spec.envAny && envHasAnyKeys(env, spec.envAny)) {
        return true;
    }
    if (spec.envAll && envHasAllKeys(env, spec.envAll)) {
        return true;
    }
    const entry = resolveChannelConfig(cfg, channelId);
    if (!entry) {
        return false;
    }
    if (spec.stringKeys && spec.stringKeys.some((key) => hasNonEmptyString(entry[key]))) {
        return true;
    }
    if (spec.numberKeys && hasAnyNumberKeys(entry, spec.numberKeys)) {
        return true;
    }
    if (spec.accountStringKeys && accountsHaveKeys(entry.accounts, spec.accountStringKeys)) {
        return true;
    }
    return recordHasKeys(entry);
}
function isWhatsAppConfigured(cfg) {
    if (hasAnyWhatsAppAuth(cfg)) {
        return true;
    }
    const entry = resolveChannelConfig(cfg, "whatsapp");
    if (!entry) {
        return false;
    }
    return recordHasKeys(entry);
}
function isGenericChannelConfigured(cfg, channelId) {
    const entry = resolveChannelConfig(cfg, channelId);
    return recordHasKeys(entry);
}
export function isChannelConfigured(cfg, channelId, env = process.env) {
    if (channelId === "whatsapp") {
        return isWhatsAppConfigured(cfg);
    }
    const spec = STRUCTURED_CHANNEL_CONFIG_SPECS[channelId];
    if (spec) {
        return isStructuredChannelConfigured(cfg, channelId, env, spec);
    }
    return isGenericChannelConfigured(cfg, channelId);
}
function collectModelRefs(cfg) {
    const refs = [];
    const pushModelRef = (value) => {
        if (typeof value === "string" && value.trim()) {
            refs.push(value.trim());
        }
    };
    const collectFromAgent = (agent) => {
        if (!agent) {
            return;
        }
        const model = agent.model;
        if (typeof model === "string") {
            pushModelRef(model);
        }
        else if (isRecord(model)) {
            pushModelRef(model.primary);
            const fallbacks = model.fallbacks;
            if (Array.isArray(fallbacks)) {
                for (const entry of fallbacks) {
                    pushModelRef(entry);
                }
            }
        }
        const models = agent.models;
        if (isRecord(models)) {
            for (const key of Object.keys(models)) {
                pushModelRef(key);
            }
        }
    };
    const defaults = cfg.agents?.defaults;
    collectFromAgent(defaults);
    const list = cfg.agents?.list;
    if (Array.isArray(list)) {
        for (const entry of list) {
            if (isRecord(entry)) {
                collectFromAgent(entry);
            }
        }
    }
    return refs;
}
function extractProviderFromModelRef(value) {
    const trimmed = value.trim();
    const slash = trimmed.indexOf("/");
    if (slash <= 0) {
        return null;
    }
    return normalizeProviderId(trimmed.slice(0, slash));
}
function isProviderConfigured(cfg, providerId) {
    const normalized = normalizeProviderId(providerId);
    const profiles = cfg.auth?.profiles;
    if (profiles && typeof profiles === "object") {
        for (const profile of Object.values(profiles)) {
            if (!isRecord(profile)) {
                continue;
            }
            const provider = normalizeProviderId(String(profile.provider ?? ""));
            if (provider === normalized) {
                return true;
            }
        }
    }
    const providerConfig = cfg.models?.providers;
    if (providerConfig && typeof providerConfig === "object") {
        for (const key of Object.keys(providerConfig)) {
            if (normalizeProviderId(key) === normalized) {
                return true;
            }
        }
    }
    const modelRefs = collectModelRefs(cfg);
    for (const ref of modelRefs) {
        const provider = extractProviderFromModelRef(ref);
        if (provider && provider === normalized) {
            return true;
        }
    }
    return false;
}
function buildChannelToPluginIdMap(registry) {
    const map = new Map();
    for (const record of registry.plugins) {
        for (const channelId of record.channels) {
            if (channelId && !map.has(channelId)) {
                map.set(channelId, record.id);
            }
        }
    }
    return map;
}
function resolvePluginIdForChannel(channelId, channelToPluginId) {
    // Third-party plugins can expose a channel id that differs from their
    // manifest id; plugins.entries must always be keyed by manifest id.
    const builtInId = normalizeChatChannelId(channelId);
    if (builtInId) {
        return builtInId;
    }
    return channelToPluginId.get(channelId) ?? channelId;
}
function collectCandidateChannelIds(cfg) {
    const channelIds = new Set(CHANNEL_PLUGIN_IDS);
    const configuredChannels = cfg.channels;
    if (!configuredChannels || typeof configuredChannels !== "object") {
        return Array.from(channelIds);
    }
    for (const key of Object.keys(configuredChannels)) {
        if (key === "defaults" || key === "modelByChannel") {
            continue;
        }
        const normalizedBuiltIn = normalizeChatChannelId(key);
        channelIds.add(normalizedBuiltIn ?? key);
    }
    return Array.from(channelIds);
}
function resolveConfiguredPlugins(cfg, env, registry) {
    const changes = [];
    // Build reverse map: channel ID → plugin ID from installed plugin manifests.
    const channelToPluginId = buildChannelToPluginIdMap(registry);
    for (const channelId of collectCandidateChannelIds(cfg)) {
        const pluginId = resolvePluginIdForChannel(channelId, channelToPluginId);
        if (isChannelConfigured(cfg, channelId, env)) {
            changes.push({ pluginId, reason: `${channelId} configured` });
        }
    }
    for (const mapping of PROVIDER_PLUGIN_IDS) {
        if (isProviderConfigured(cfg, mapping.providerId)) {
            changes.push({
                pluginId: mapping.pluginId,
                reason: `${mapping.providerId} auth configured`,
            });
        }
    }
    const backendRaw = typeof cfg.acp?.backend === "string" ? cfg.acp.backend.trim().toLowerCase() : "";
    const acpConfigured = cfg.acp?.enabled === true || cfg.acp?.dispatch?.enabled === true || backendRaw === "acpx";
    if (acpConfigured && (!backendRaw || backendRaw === "acpx")) {
        changes.push({
            pluginId: "acpx",
            reason: "ACP runtime configured",
        });
    }
    return changes;
}
function isPluginExplicitlyDisabled(cfg, pluginId) {
    const builtInChannelId = normalizeChatChannelId(pluginId);
    if (builtInChannelId) {
        const channels = cfg.channels;
        const channelConfig = channels?.[builtInChannelId];
        if (channelConfig &&
            typeof channelConfig === "object" &&
            !Array.isArray(channelConfig) &&
            channelConfig.enabled === false) {
            return true;
        }
    }
    const entry = cfg.plugins?.entries?.[pluginId];
    return entry?.enabled === false;
}
function isPluginDenied(cfg, pluginId) {
    const deny = cfg.plugins?.deny;
    return Array.isArray(deny) && deny.includes(pluginId);
}
function resolvePreferredOverIds(pluginId) {
    const normalized = normalizeChatChannelId(pluginId);
    if (normalized) {
        return getChatChannelMeta(normalized).preferOver ?? [];
    }
    const catalogEntry = getChannelPluginCatalogEntry(pluginId);
    return catalogEntry?.meta.preferOver ?? [];
}
function shouldSkipPreferredPluginAutoEnable(cfg, entry, configured) {
    for (const other of configured) {
        if (other.pluginId === entry.pluginId) {
            continue;
        }
        if (isPluginDenied(cfg, other.pluginId)) {
            continue;
        }
        if (isPluginExplicitlyDisabled(cfg, other.pluginId)) {
            continue;
        }
        const preferOver = resolvePreferredOverIds(other.pluginId);
        if (preferOver.includes(entry.pluginId)) {
            return true;
        }
    }
    return false;
}
function registerPluginEntry(cfg, pluginId) {
    const builtInChannelId = normalizeChatChannelId(pluginId);
    if (builtInChannelId) {
        const channels = cfg.channels;
        const existing = channels?.[builtInChannelId];
        const existingRecord = existing && typeof existing === "object" && !Array.isArray(existing)
            ? existing
            : {};
        return {
            ...cfg,
            channels: {
                ...cfg.channels,
                [builtInChannelId]: {
                    ...existingRecord,
                    enabled: true,
                },
            },
        };
    }
    const entries = {
        ...cfg.plugins?.entries,
        [pluginId]: {
            ...cfg.plugins?.entries?.[pluginId],
            enabled: true,
        },
    };
    return {
        ...cfg,
        plugins: {
            ...cfg.plugins,
            entries,
        },
    };
}
function formatAutoEnableChange(entry) {
    let reason = entry.reason.trim();
    const channelId = normalizeChatChannelId(entry.pluginId);
    if (channelId) {
        const label = getChatChannelMeta(channelId).label;
        reason = reason.replace(new RegExp(`^${channelId}\\b`, "i"), label);
    }
    return `${reason}, enabled automatically.`;
}
export function applyPluginAutoEnable(params) {
    const env = params.env ?? process.env;
    const registry = params.manifestRegistry ?? loadPluginManifestRegistry({ config: params.config });
    const configured = resolveConfiguredPlugins(params.config, env, registry);
    if (configured.length === 0) {
        return { config: params.config, changes: [] };
    }
    let next = params.config;
    const changes = [];
    if (next.plugins?.enabled === false) {
        return { config: next, changes };
    }
    for (const entry of configured) {
        const builtInChannelId = normalizeChatChannelId(entry.pluginId);
        if (isPluginDenied(next, entry.pluginId)) {
            continue;
        }
        if (isPluginExplicitlyDisabled(next, entry.pluginId)) {
            continue;
        }
        if (shouldSkipPreferredPluginAutoEnable(next, entry, configured)) {
            continue;
        }
        const allow = next.plugins?.allow;
        const allowMissing = Array.isArray(allow) && !allow.includes(entry.pluginId);
        const alreadyEnabled = builtInChannelId != null
            ? (() => {
                const channels = next.channels;
                const channelConfig = channels?.[builtInChannelId];
                if (!channelConfig ||
                    typeof channelConfig !== "object" ||
                    Array.isArray(channelConfig)) {
                    return false;
                }
                return channelConfig.enabled === true;
            })()
            : next.plugins?.entries?.[entry.pluginId]?.enabled === true;
        if (alreadyEnabled && !allowMissing) {
            continue;
        }
        next = registerPluginEntry(next, entry.pluginId);
        if (allowMissing || !builtInChannelId) {
            next = ensurePluginAllowlisted(next, entry.pluginId);
        }
        changes.push(formatAutoEnableChange(entry));
    }
    return { config: next, changes };
}
