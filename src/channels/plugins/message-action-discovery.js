import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { normalizeAnyChannelId } from "../registry.js";
import { getChannelPlugin, getLoadedChannelPlugin, listChannelPlugins } from "./index.js";
import { resolveBundledChannelMessageToolDiscoveryAdapter, } from "./message-tool-api.js";
const loggedMessageActionErrors = new Set();
export function resolveMessageActionDiscoveryChannelId(raw) {
    return normalizeAnyChannelId(raw) ?? normalizeOptionalString(raw);
}
export function createMessageActionDiscoveryContext(params) {
    const currentChannelProvider = resolveMessageActionDiscoveryChannelId(params.channel ?? params.currentChannelProvider);
    return {
        cfg: params.cfg ?? {},
        currentChannelId: params.currentChannelId,
        currentChannelProvider,
        currentThreadTs: params.currentThreadTs,
        currentMessageId: params.currentMessageId,
        accountId: params.accountId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        agentId: params.agentId,
        requesterSenderId: params.requesterSenderId,
        senderIsOwner: params.senderIsOwner,
    };
}
function logMessageActionError(params) {
    const message = formatErrorMessage(params.error);
    const key = `${params.pluginId}:${params.operation}:${message}`;
    if (loggedMessageActionErrors.has(key)) {
        return;
    }
    loggedMessageActionErrors.add(key);
    const stack = params.error instanceof Error && params.error.stack ? params.error.stack : null;
    defaultRuntime.error?.(`[message-action-discovery] ${params.pluginId}.actions.${params.operation} failed: ${stack ?? message}`);
}
function describeMessageToolSafely(params) {
    try {
        return params.describeMessageTool(params.context) ?? null;
    }
    catch (error) {
        logMessageActionError({
            pluginId: params.pluginId,
            operation: "describeMessageTool",
            error,
        });
        return null;
    }
}
function normalizeToolSchemaContributions(value) {
    if (!value) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}
function normalizeMessageToolMediaSourceParams(mediaSourceParams, action) {
    if (Array.isArray(mediaSourceParams)) {
        return mediaSourceParams;
    }
    if (!mediaSourceParams || typeof mediaSourceParams !== "object") {
        return [];
    }
    const scopedMediaSourceParams = mediaSourceParams;
    if (action) {
        const scoped = scopedMediaSourceParams[action];
        return Array.isArray(scoped) ? scoped : [];
    }
    return Object.values(scopedMediaSourceParams).flatMap((scoped) => Array.isArray(scoped) ? scoped : []);
}
export function resolveCurrentChannelMessageToolDiscoveryAdapter(channel) {
    const channelId = resolveMessageActionDiscoveryChannelId(channel);
    if (!channelId) {
        return null;
    }
    const loadedPlugin = getLoadedChannelPlugin(channelId);
    if (loadedPlugin?.actions) {
        return {
            pluginId: loadedPlugin.id,
            actions: loadedPlugin.actions,
        };
    }
    const bundledActions = resolveBundledChannelMessageToolDiscoveryAdapter(channelId);
    if (bundledActions) {
        return {
            pluginId: channelId,
            actions: bundledActions,
        };
    }
    const plugin = getChannelPlugin(channelId);
    if (!plugin?.actions) {
        return null;
    }
    return {
        pluginId: plugin.id,
        actions: plugin.actions,
    };
}
export function resolveMessageActionDiscoveryForPlugin(params) {
    const adapter = params.actions;
    if (!adapter) {
        return {
            actions: [],
            capabilities: [],
            schemaContributions: [],
            mediaSourceParams: [],
        };
    }
    const described = describeMessageToolSafely({
        pluginId: params.pluginId,
        context: params.context,
        describeMessageTool: adapter.describeMessageTool,
    });
    return {
        actions: params.includeActions && Array.isArray(described?.actions) ? [...described.actions] : [],
        capabilities: params.includeCapabilities && Array.isArray(described?.capabilities)
            ? described.capabilities
            : [],
        schemaContributions: params.includeSchema
            ? normalizeToolSchemaContributions(described?.schema)
            : [],
        mediaSourceParams: normalizeMessageToolMediaSourceParams(described?.mediaSourceParams, params.action),
    };
}
export function listChannelMessageActions(cfg) {
    const actions = new Set(["send", "broadcast"]);
    for (const plugin of listChannelPlugins()) {
        for (const action of resolveMessageActionDiscoveryForPlugin({
            pluginId: plugin.id,
            actions: plugin.actions,
            context: { cfg },
            includeActions: true,
        }).actions) {
            actions.add(action);
        }
    }
    return Array.from(actions);
}
export function listCrossChannelSchemaSupportedMessageActions(params) {
    const channelId = resolveMessageActionDiscoveryChannelId(params.channel);
    if (!channelId) {
        return [];
    }
    const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(channelId);
    if (!pluginActions?.actions) {
        return [];
    }
    const resolved = resolveMessageActionDiscoveryForPlugin({
        pluginId: pluginActions.pluginId,
        actions: pluginActions.actions,
        context: createMessageActionDiscoveryContext(params),
        includeActions: true,
        includeSchema: true,
    });
    const schemaBlockedActions = new Set();
    for (const contribution of resolved.schemaContributions) {
        if ((contribution.visibility ?? "current-channel") !== "current-channel") {
            continue;
        }
        if (!Object.hasOwn(contribution, "actions")) {
            return [];
        }
        const actions = contribution.actions;
        if (!Array.isArray(actions)) {
            return [];
        }
        if (actions.length === 0) {
            continue;
        }
        for (const action of actions) {
            schemaBlockedActions.add(action);
        }
    }
    return resolved.actions.filter((action) => !schemaBlockedActions.has(action));
}
export function listChannelMessageCapabilities(cfg) {
    const capabilities = new Set();
    for (const plugin of listChannelPlugins()) {
        for (const capability of resolveMessageActionDiscoveryForPlugin({
            pluginId: plugin.id,
            actions: plugin.actions,
            context: { cfg },
            includeCapabilities: true,
        }).capabilities) {
            capabilities.add(capability);
        }
    }
    return Array.from(capabilities);
}
export function listChannelMessageCapabilitiesForChannel(params) {
    const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(params.channel);
    if (!pluginActions) {
        return [];
    }
    return Array.from(resolveMessageActionDiscoveryForPlugin({
        pluginId: pluginActions.pluginId,
        actions: pluginActions.actions,
        context: createMessageActionDiscoveryContext(params),
        includeCapabilities: true,
    }).capabilities);
}
function mergeToolSchemaProperties(target, source) {
    if (!source) {
        return;
    }
    for (const [name, schema] of Object.entries(source)) {
        if (!(name in target)) {
            target[name] = schema;
        }
    }
}
export function resolveChannelMessageToolSchemaProperties(params) {
    const properties = {};
    const currentChannel = resolveMessageActionDiscoveryChannelId(params.channel);
    const discoveryBase = createMessageActionDiscoveryContext(params);
    const seenPluginIds = new Set();
    for (const plugin of listChannelPlugins()) {
        if (!plugin.actions) {
            continue;
        }
        seenPluginIds.add(plugin.id);
        for (const contribution of resolveMessageActionDiscoveryForPlugin({
            pluginId: plugin.id,
            actions: plugin.actions,
            context: discoveryBase,
            includeSchema: true,
        }).schemaContributions) {
            const visibility = contribution.visibility ?? "current-channel";
            if (currentChannel) {
                if (visibility === "all-configured" || plugin.id === currentChannel) {
                    mergeToolSchemaProperties(properties, contribution.properties);
                }
                continue;
            }
            mergeToolSchemaProperties(properties, contribution.properties);
        }
    }
    if (currentChannel && !seenPluginIds.has(currentChannel)) {
        const currentActions = resolveCurrentChannelMessageToolDiscoveryAdapter(currentChannel);
        if (currentActions?.actions) {
            for (const contribution of resolveMessageActionDiscoveryForPlugin({
                pluginId: currentActions.pluginId,
                actions: currentActions.actions,
                context: discoveryBase,
                includeSchema: true,
            }).schemaContributions) {
                const visibility = contribution.visibility ?? "current-channel";
                if (visibility === "all-configured" || currentActions.pluginId === currentChannel) {
                    mergeToolSchemaProperties(properties, contribution.properties);
                }
            }
        }
    }
    return properties;
}
export function resolveChannelMessageToolMediaSourceParamKeys(params) {
    const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(params.channel);
    if (!pluginActions) {
        return [];
    }
    const described = resolveMessageActionDiscoveryForPlugin({
        pluginId: pluginActions.pluginId,
        actions: pluginActions.actions,
        context: createMessageActionDiscoveryContext(params),
        action: params.action,
        includeSchema: false,
    });
    return Array.from(new Set(described.mediaSourceParams));
}
export function channelSupportsMessageCapability(cfg, capability) {
    return listChannelMessageCapabilities(cfg).includes(capability);
}
export function channelSupportsMessageCapabilityForChannel(params, capability) {
    return listChannelMessageCapabilitiesForChannel(params).includes(capability);
}
export const __testing = {
    resetLoggedMessageActionErrors() {
        loggedMessageActionErrors.clear();
    },
};
