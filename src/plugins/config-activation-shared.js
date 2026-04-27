export const PLUGIN_ACTIVATION_REASON_BY_CAUSE = {
    "enabled-in-config": "enabled in config",
    "bundled-channel-enabled-in-config": "channel enabled in config",
    "selected-memory-slot": "selected memory slot",
    "selected-context-engine-slot": "selected context engine slot",
    "selected-in-allowlist": "selected in allowlist",
    "plugins-disabled": "plugins disabled",
    "blocked-by-denylist": "blocked by denylist",
    "disabled-in-config": "disabled in config",
    "workspace-disabled-by-default": "workspace plugin (disabled by default)",
    "not-in-allowlist": "not in allowlist",
    "enabled-by-effective-config": "enabled by effective config",
    "bundled-channel-configured": "channel configured",
    "bundled-default-enablement": "bundled default enablement",
    "bundled-disabled-by-default": "bundled (disabled by default)",
};
export function resolvePluginActivationReason(cause, reason) {
    if (reason) {
        return reason;
    }
    return cause ? PLUGIN_ACTIVATION_REASON_BY_CAUSE[cause] : undefined;
}
export function toPluginActivationState(decision) {
    return {
        enabled: decision.enabled,
        activated: decision.activated,
        explicitlyEnabled: decision.explicitlyEnabled,
        source: decision.source,
        reason: resolvePluginActivationReason(decision.cause, decision.reason),
    };
}
function resolveExplicitPluginSelectionShared(params) {
    if (params.config.entries[params.id]?.enabled === true) {
        return { explicitlyEnabled: true, cause: "enabled-in-config" };
    }
    if (params.origin === "bundled" &&
        params.isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)) {
        return { explicitlyEnabled: true, cause: "bundled-channel-enabled-in-config" };
    }
    if (params.config.slots.memory === params.id) {
        return { explicitlyEnabled: true, cause: "selected-memory-slot" };
    }
    if (params.config.slots.contextEngine === params.id) {
        return { explicitlyEnabled: true, cause: "selected-context-engine-slot" };
    }
    if (params.origin !== "bundled" && params.config.allow.includes(params.id)) {
        return { explicitlyEnabled: true, cause: "selected-in-allowlist" };
    }
    return { explicitlyEnabled: false };
}
export function resolvePluginActivationDecisionShared(params) {
    const activationSource = params.activationSource ?? {
        plugins: params.config,
        rootConfig: params.rootConfig,
    };
    const explicitSelection = resolveExplicitPluginSelectionShared({
        id: params.id,
        origin: params.origin,
        config: activationSource.plugins,
        rootConfig: activationSource.rootConfig,
        isBundledChannelEnabledByChannelConfig: params.isBundledChannelEnabledByChannelConfig,
    });
    if (!params.config.enabled) {
        return {
            enabled: false,
            activated: false,
            explicitlyEnabled: explicitSelection.explicitlyEnabled,
            source: "disabled",
            cause: "plugins-disabled",
        };
    }
    if (params.config.deny.includes(params.id)) {
        return {
            enabled: false,
            activated: false,
            explicitlyEnabled: explicitSelection.explicitlyEnabled,
            source: "disabled",
            cause: "blocked-by-denylist",
        };
    }
    const entry = params.config.entries[params.id];
    if (entry?.enabled === false) {
        return {
            enabled: false,
            activated: false,
            explicitlyEnabled: explicitSelection.explicitlyEnabled,
            source: "disabled",
            cause: "disabled-in-config",
        };
    }
    const explicitlyAllowed = params.config.allow.includes(params.id);
    if (params.origin === "workspace" &&
        !explicitlyAllowed &&
        entry?.enabled !== true &&
        explicitSelection.cause !== "selected-context-engine-slot") {
        return {
            enabled: false,
            activated: false,
            explicitlyEnabled: explicitSelection.explicitlyEnabled,
            source: "disabled",
            cause: "workspace-disabled-by-default",
        };
    }
    if (params.config.slots.memory === params.id) {
        return {
            enabled: true,
            activated: true,
            explicitlyEnabled: true,
            source: "explicit",
            cause: "selected-memory-slot",
        };
    }
    if (params.config.slots.contextEngine === params.id) {
        return {
            enabled: true,
            activated: true,
            explicitlyEnabled: true,
            source: "explicit",
            cause: "selected-context-engine-slot",
        };
    }
    if (params.allowBundledChannelExplicitBypassesAllowlist === true &&
        explicitSelection.cause === "bundled-channel-enabled-in-config") {
        return {
            enabled: true,
            activated: true,
            explicitlyEnabled: true,
            source: "explicit",
            cause: explicitSelection.cause,
        };
    }
    if (params.config.allow.length > 0 && !explicitlyAllowed) {
        return {
            enabled: false,
            activated: false,
            explicitlyEnabled: explicitSelection.explicitlyEnabled,
            source: "disabled",
            cause: "not-in-allowlist",
        };
    }
    if (explicitSelection.explicitlyEnabled) {
        return {
            enabled: true,
            activated: true,
            explicitlyEnabled: true,
            source: "explicit",
            cause: explicitSelection.cause,
        };
    }
    if (params.autoEnabledReason) {
        return {
            enabled: true,
            activated: true,
            explicitlyEnabled: false,
            source: "auto",
            reason: params.autoEnabledReason,
        };
    }
    if (entry?.enabled === true) {
        return {
            enabled: true,
            activated: true,
            explicitlyEnabled: false,
            source: "auto",
            cause: "enabled-by-effective-config",
        };
    }
    if (params.origin === "bundled" &&
        params.isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)) {
        return {
            enabled: true,
            activated: true,
            explicitlyEnabled: false,
            source: "auto",
            cause: "bundled-channel-configured",
        };
    }
    if (params.origin === "bundled" && params.enabledByDefault === true) {
        return {
            enabled: true,
            activated: true,
            explicitlyEnabled: false,
            source: "default",
            cause: "bundled-default-enablement",
        };
    }
    if (params.origin === "bundled") {
        return {
            enabled: false,
            activated: false,
            explicitlyEnabled: false,
            source: "disabled",
            cause: "bundled-disabled-by-default",
        };
    }
    return {
        enabled: true,
        activated: true,
        explicitlyEnabled: explicitSelection.explicitlyEnabled,
        source: "default",
    };
}
export function toEnableStateResult(state) {
    return state.enabled ? { enabled: true } : { enabled: false, reason: state.reason };
}
export function resolveEnableStateResult(params, resolveState) {
    return toEnableStateResult(resolveState(params));
}
export function resolveEnableStateShared(params, resolveState) {
    return resolveEnableStateResult(params, resolveState);
}
export function createPluginEnableStateResolver(resolveState) {
    return (id, origin, config, enabledByDefault) => resolveEnableStateResult({ id, origin, config, enabledByDefault }, resolveState);
}
export function createEffectiveEnableStateResolver(resolveState) {
    return (params) => resolveEnableStateResult(params, resolveState);
}
function hasKind(kind, target) {
    if (!kind) {
        return false;
    }
    return Array.isArray(kind) ? kind.includes(target) : kind === target;
}
export function resolveMemorySlotDecisionShared(params) {
    if (!hasKind(params.kind, "memory")) {
        return { enabled: true };
    }
    // A dual-kind plugin (e.g. ["memory", "context-engine"]) that lost the
    // memory slot must stay enabled so its other slot role can still load.
    const isMultiKind = Array.isArray(params.kind) && params.kind.length > 1;
    if (params.slot === null) {
        return isMultiKind ? { enabled: true } : { enabled: false, reason: "memory slot disabled" };
    }
    if (typeof params.slot === "string") {
        if (params.slot === params.id) {
            return { enabled: true, selected: true };
        }
        return isMultiKind
            ? { enabled: true }
            : { enabled: false, reason: `memory slot set to "${params.slot}"` };
    }
    if (params.selectedId && params.selectedId !== params.id) {
        return isMultiKind
            ? { enabled: true }
            : { enabled: false, reason: `memory slot already filled by "${params.selectedId}"` };
    }
    return { enabled: true, selected: true };
}
