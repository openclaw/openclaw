import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { normalizePluginInteractiveNamespace, resolvePluginInteractiveMatch, toPluginInteractiveRegistryKey, validatePluginInteractiveNamespace, } from "./interactive-shared.js";
import { clearPluginInteractiveHandlerRegistrationsState, clearPluginInteractiveHandlersState, getPluginInteractiveHandlersState, } from "./interactive-state.js";
export function resolvePluginInteractiveNamespaceMatch(channel, data) {
    return resolvePluginInteractiveMatch({
        interactiveHandlers: getPluginInteractiveHandlersState(),
        channel,
        data,
    });
}
export function registerPluginInteractiveHandler(pluginId, registration, opts) {
    const interactiveHandlers = getPluginInteractiveHandlersState();
    const namespace = normalizePluginInteractiveNamespace(registration.namespace);
    const validationError = validatePluginInteractiveNamespace(namespace);
    if (validationError) {
        return { ok: false, error: validationError };
    }
    const key = toPluginInteractiveRegistryKey(registration.channel, namespace);
    const existing = interactiveHandlers.get(key);
    if (existing) {
        return {
            ok: false,
            error: `Interactive handler namespace "${namespace}" already registered by plugin "${existing.pluginId}"`,
        };
    }
    interactiveHandlers.set(key, {
        ...registration,
        namespace,
        channel: normalizeOptionalLowercaseString(registration.channel) ?? "",
        pluginId,
        pluginName: opts?.pluginName,
        pluginRoot: opts?.pluginRoot,
    });
    return { ok: true };
}
export function clearPluginInteractiveHandlers() {
    clearPluginInteractiveHandlersState();
}
export function clearPluginInteractiveHandlerRegistrations() {
    clearPluginInteractiveHandlerRegistrationsState();
}
export function clearPluginInteractiveHandlersForPlugin(pluginId) {
    const interactiveHandlers = getPluginInteractiveHandlersState();
    for (const [key, value] of interactiveHandlers.entries()) {
        if (value.pluginId === pluginId) {
            interactiveHandlers.delete(key);
        }
    }
}
export function listPluginInteractiveHandlers() {
    return Array.from(getPluginInteractiveHandlersState().values());
}
export function restorePluginInteractiveHandlers(registrations) {
    clearPluginInteractiveHandlerRegistrations();
    const interactiveHandlers = getPluginInteractiveHandlersState();
    for (const registration of registrations) {
        const namespace = normalizePluginInteractiveNamespace(registration.namespace);
        if (!namespace) {
            continue;
        }
        interactiveHandlers.set(toPluginInteractiveRegistryKey(registration.channel, namespace), {
            ...registration,
            namespace,
            channel: normalizeOptionalLowercaseString(registration.channel) ?? "",
        });
    }
}
