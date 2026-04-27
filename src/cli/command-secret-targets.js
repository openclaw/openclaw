import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import { normalizeOptionalAccountId } from "../routing/session-key.js";
import { discoverConfigSecretTargetsByIds, listSecretTargetRegistryEntries, } from "../secrets/target-registry.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
const STATIC_QR_REMOTE_TARGET_IDS = ["gateway.remote.token", "gateway.remote.password"];
const STATIC_MODEL_TARGET_IDS = [
    "models.providers.*.apiKey",
    "models.providers.*.headers.*",
    "models.providers.*.request.headers.*",
    "models.providers.*.request.auth.token",
    "models.providers.*.request.auth.value",
    "models.providers.*.request.proxy.tls.ca",
    "models.providers.*.request.proxy.tls.cert",
    "models.providers.*.request.proxy.tls.key",
    "models.providers.*.request.proxy.tls.passphrase",
    "models.providers.*.request.tls.ca",
    "models.providers.*.request.tls.cert",
    "models.providers.*.request.tls.key",
    "models.providers.*.request.tls.passphrase",
];
const STATIC_AGENT_RUNTIME_BASE_TARGET_IDS = [
    ...STATIC_MODEL_TARGET_IDS,
    "agents.defaults.memorySearch.remote.apiKey",
    "agents.list[].memorySearch.remote.apiKey",
    "messages.tts.providers.*.apiKey",
    "skills.entries.*.apiKey",
    "tools.web.search.apiKey",
];
const STATIC_STATUS_TARGET_IDS = [
    "agents.defaults.memorySearch.remote.apiKey",
    "agents.list[].memorySearch.remote.apiKey",
];
const STATIC_SECURITY_AUDIT_TARGET_IDS = [
    "gateway.auth.token",
    "gateway.auth.password",
    "gateway.remote.token",
    "gateway.remote.password",
];
function idsByPrefix(prefixes) {
    return listSecretTargetRegistryEntries()
        .map((entry) => entry.id)
        .filter((id) => prefixes.some((prefix) => id.startsWith(prefix)))
        .toSorted();
}
let cachedCommandSecretTargets;
let cachedAgentRuntimeBaseTargetIds;
let cachedChannelSecretTargetIds;
function getChannelSecretTargetIds() {
    cachedChannelSecretTargetIds ??= idsByPrefix(["channels."]);
    return cachedChannelSecretTargetIds;
}
function isPluginWebCredentialTargetId(id) {
    const segments = id.split(".");
    if (segments[0] !== "plugins" || segments[1] !== "entries" || segments[3] !== "config") {
        return false;
    }
    const configPath = segments.slice(4).join(".");
    return configPath === "webSearch.apiKey" || configPath === "webFetch.apiKey";
}
function getAgentRuntimeBaseTargetIds() {
    cachedAgentRuntimeBaseTargetIds ??= [
        ...STATIC_AGENT_RUNTIME_BASE_TARGET_IDS,
        ...listSecretTargetRegistryEntries()
            .map((entry) => entry.id)
            .filter(isPluginWebCredentialTargetId)
            .toSorted(),
    ];
    return cachedAgentRuntimeBaseTargetIds;
}
function isScopedChannelSecretTargetEntry(params) {
    const channelId = normalizeOptionalString(params.pluginChannelId);
    if (!channelId) {
        return false;
    }
    const allowedPrefix = `channels.${channelId}.`;
    return (params.entry.id.startsWith(allowedPrefix) &&
        params.entry.configFile === "openclaw.json" &&
        typeof params.entry.pathPattern === "string" &&
        params.entry.pathPattern.startsWith(allowedPrefix) &&
        (params.entry.refPathPattern === undefined ||
            params.entry.refPathPattern.startsWith(allowedPrefix)));
}
function getConfiguredChannelSecretTargetIds(config, env = process.env) {
    const targetIds = new Set();
    for (const plugin of listReadOnlyChannelPluginsForConfig(config, {
        env,
        includePersistedAuthState: false,
    })) {
        for (const entry of plugin.secrets?.secretTargetRegistryEntries ?? []) {
            if (isScopedChannelSecretTargetEntry({ entry, pluginChannelId: plugin.id })) {
                targetIds.add(entry.id);
            }
        }
    }
    return [...targetIds].toSorted((left, right) => left.localeCompare(right));
}
function buildCommandSecretTargets() {
    const channelTargetIds = getChannelSecretTargetIds();
    return {
        channels: channelTargetIds,
        agentRuntime: [...getAgentRuntimeBaseTargetIds(), ...channelTargetIds],
        status: [...STATIC_STATUS_TARGET_IDS, ...channelTargetIds],
        securityAudit: [...STATIC_SECURITY_AUDIT_TARGET_IDS, ...channelTargetIds],
    };
}
function getCommandSecretTargets() {
    cachedCommandSecretTargets ??= buildCommandSecretTargets();
    return cachedCommandSecretTargets;
}
function toTargetIdSet(values) {
    return new Set(values);
}
function selectChannelTargetIds(channel) {
    const commandSecretTargets = getCommandSecretTargets();
    if (!channel) {
        return toTargetIdSet(commandSecretTargets.channels);
    }
    return toTargetIdSet(commandSecretTargets.channels.filter((id) => id.startsWith(`channels.${channel}.`)));
}
function pathTargetsScopedChannelAccount(params) {
    const [root, channelId, accountRoot, accountId] = params.pathSegments;
    if (root !== "channels" || channelId !== params.channel) {
        return false;
    }
    if (accountRoot !== "accounts") {
        return true;
    }
    return accountId === params.accountId;
}
export function getScopedChannelsCommandSecretTargets(params) {
    const channel = normalizeOptionalString(params.channel);
    const targetIds = selectChannelTargetIds(channel);
    const normalizedAccountId = normalizeOptionalAccountId(params.accountId);
    if (!channel || !normalizedAccountId) {
        return { targetIds };
    }
    const allowedPaths = new Set();
    for (const target of discoverConfigSecretTargetsByIds(params.config, targetIds)) {
        if (pathTargetsScopedChannelAccount({
            pathSegments: target.pathSegments,
            channel,
            accountId: normalizedAccountId,
        })) {
            allowedPaths.add(target.path);
        }
    }
    return { targetIds, allowedPaths };
}
export function getQrRemoteCommandSecretTargetIds() {
    return toTargetIdSet(STATIC_QR_REMOTE_TARGET_IDS);
}
export function getChannelsCommandSecretTargetIds() {
    return toTargetIdSet(getCommandSecretTargets().channels);
}
export function getConfiguredChannelsCommandSecretTargetIds(config, env) {
    return toTargetIdSet(getConfiguredChannelSecretTargetIds(config, env));
}
export function getModelsCommandSecretTargetIds() {
    return toTargetIdSet(STATIC_MODEL_TARGET_IDS);
}
export function getAgentRuntimeCommandSecretTargetIds(params) {
    if (params?.includeChannelTargets !== true) {
        return toTargetIdSet(getAgentRuntimeBaseTargetIds());
    }
    return toTargetIdSet(getCommandSecretTargets().agentRuntime);
}
export function getStatusCommandSecretTargetIds(config, env) {
    const channelTargetIds = config
        ? getConfiguredChannelSecretTargetIds(config, env)
        : getChannelSecretTargetIds();
    return toTargetIdSet([...STATIC_STATUS_TARGET_IDS, ...channelTargetIds]);
}
export function getSecurityAuditCommandSecretTargetIds() {
    return toTargetIdSet(getCommandSecretTargets().securityAudit);
}
