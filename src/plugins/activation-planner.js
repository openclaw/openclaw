import { normalizeProviderId } from "../agents/provider-id.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { createPluginIdScopeSet, normalizePluginIdScope } from "./plugin-scope.js";
export function resolveManifestActivationPlan(params) {
    const onlyPluginIdSet = createPluginIdScopeSet(normalizePluginIdScope(params.onlyPluginIds));
    const registry = loadPluginManifestRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        cache: params.cache,
    });
    const entries = registry.plugins
        .flatMap((plugin) => {
        if (params.origin && plugin.origin !== params.origin) {
            return [];
        }
        if (onlyPluginIdSet && !onlyPluginIdSet.has(plugin.id)) {
            return [];
        }
        const reasons = listManifestActivationTriggerReasons(plugin, params.trigger);
        if (reasons.length === 0) {
            return [];
        }
        return [
            {
                pluginId: plugin.id,
                origin: plugin.origin,
                reasons,
            },
        ];
    })
        .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
    return {
        trigger: params.trigger,
        pluginIds: [...new Set(entries.map((entry) => entry.pluginId))],
        entries,
        diagnostics: registry.diagnostics,
    };
}
export function resolveManifestActivationPluginIds(params) {
    return [...resolveManifestActivationPlan(params).pluginIds];
}
function listManifestActivationTriggerReasons(plugin, trigger) {
    switch (trigger.kind) {
        case "command":
            return listCommandTriggerReasons(plugin, normalizeCommandId(trigger.command));
        case "provider":
            return listProviderTriggerReasons(plugin, normalizeProviderId(trigger.provider));
        case "agentHarness":
            return listAgentHarnessTriggerReasons(plugin, normalizeCommandId(trigger.runtime));
        case "channel":
            return listChannelTriggerReasons(plugin, normalizeCommandId(trigger.channel));
        case "route":
            return listRouteTriggerReasons(plugin, normalizeCommandId(trigger.route));
        case "capability":
            return listCapabilityTriggerReasons(plugin, trigger.capability);
    }
    const unreachableTrigger = trigger;
    return unreachableTrigger;
}
function listAgentHarnessTriggerReasons(plugin, runtime) {
    return listHasNormalizedValue(plugin.activation?.onAgentHarnesses, runtime, normalizeCommandId)
        ? ["activation-agent-harness-hint"]
        : [];
}
function listCommandTriggerReasons(plugin, command) {
    return dedupeReasons([
        listHasNormalizedValue(plugin.activation?.onCommands, command, normalizeCommandId)
            ? "activation-command-hint"
            : null,
        listHasNormalizedValue((plugin.commandAliases ?? []).flatMap((alias) => alias.cliCommand ?? alias.name), command, normalizeCommandId)
            ? "manifest-command-alias"
            : null,
    ]);
}
function listProviderTriggerReasons(plugin, provider) {
    return dedupeReasons([
        listHasNormalizedValue(plugin.activation?.onProviders, provider, normalizeProviderId)
            ? "activation-provider-hint"
            : null,
        listHasNormalizedValue(plugin.providers, provider, normalizeProviderId)
            ? "manifest-provider-owner"
            : null,
        listHasNormalizedValue(plugin.setup?.providers?.map((setupProvider) => setupProvider.id), provider, normalizeProviderId)
            ? "manifest-setup-provider-owner"
            : null,
    ]);
}
function listChannelTriggerReasons(plugin, channel) {
    return dedupeReasons([
        listHasNormalizedValue(plugin.activation?.onChannels, channel, normalizeCommandId)
            ? "activation-channel-hint"
            : null,
        listHasNormalizedValue(plugin.channels, channel, normalizeCommandId)
            ? "manifest-channel-owner"
            : null,
    ]);
}
function listRouteTriggerReasons(plugin, route) {
    return listHasNormalizedValue(plugin.activation?.onRoutes, route, normalizeCommandId)
        ? ["activation-route-hint"]
        : [];
}
function listCapabilityTriggerReasons(plugin, capability) {
    switch (capability) {
        case "provider":
            return dedupeReasons([
                plugin.activation?.onCapabilities?.includes(capability)
                    ? "activation-capability-hint"
                    : null,
                hasValues(plugin.activation?.onProviders) ? "activation-provider-hint" : null,
                hasValues(plugin.providers) ? "manifest-provider-owner" : null,
                hasValues(plugin.setup?.providers) ? "manifest-setup-provider-owner" : null,
            ]);
        case "channel":
            return dedupeReasons([
                plugin.activation?.onCapabilities?.includes(capability)
                    ? "activation-capability-hint"
                    : null,
                hasValues(plugin.activation?.onChannels) ? "activation-channel-hint" : null,
                hasValues(plugin.channels) ? "manifest-channel-owner" : null,
            ]);
        case "tool":
            return dedupeReasons([
                plugin.activation?.onCapabilities?.includes(capability)
                    ? "activation-capability-hint"
                    : null,
                hasValues(plugin.contracts?.tools) ? "manifest-tool-contract" : null,
            ]);
        case "hook":
            return dedupeReasons([
                plugin.activation?.onCapabilities?.includes(capability)
                    ? "activation-capability-hint"
                    : null,
                hasValues(plugin.hooks) ? "manifest-hook-owner" : null,
            ]);
    }
    const unreachableCapability = capability;
    return unreachableCapability;
}
function listHasNormalizedValue(values, expected, normalize) {
    return values?.some((value) => normalize(value) === expected) ?? false;
}
function hasValues(values) {
    return (values?.length ?? 0) > 0;
}
function dedupeReasons(reasons) {
    return [
        ...new Set(reasons.filter((reason) => !!reason)),
    ];
}
function normalizeCommandId(value) {
    return normalizeOptionalLowercaseString(value) ?? "";
}
