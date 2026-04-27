import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
export function toPluginInteractiveRegistryKey(channel, namespace) {
    return `${normalizeOptionalLowercaseString(channel) ?? ""}:${namespace.trim()}`;
}
export function normalizePluginInteractiveNamespace(namespace) {
    return namespace.trim();
}
export function validatePluginInteractiveNamespace(namespace) {
    if (!namespace.trim()) {
        return "Interactive handler namespace cannot be empty";
    }
    if (!/^[A-Za-z0-9._-]+$/.test(namespace.trim())) {
        return "Interactive handler namespace must contain only letters, numbers, dots, underscores, and hyphens";
    }
    return null;
}
export function resolvePluginInteractiveMatch(params) {
    const trimmedData = params.data.trim();
    if (!trimmedData) {
        return null;
    }
    const separatorIndex = trimmedData.indexOf(":");
    const namespace = separatorIndex >= 0
        ? trimmedData.slice(0, separatorIndex)
        : normalizePluginInteractiveNamespace(trimmedData);
    const registration = params.interactiveHandlers.get(toPluginInteractiveRegistryKey(params.channel, namespace));
    if (!registration) {
        return null;
    }
    return {
        registration,
        namespace,
        payload: separatorIndex >= 0 ? trimmedData.slice(separatorIndex + 1) : "",
    };
}
