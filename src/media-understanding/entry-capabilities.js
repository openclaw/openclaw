import { normalizeMediaProviderId } from "./provider-id.js";
const MEDIA_CAPABILITIES = ["audio", "image", "video"];
function isMediaCapability(value) {
    return typeof value === "string" && MEDIA_CAPABILITIES.includes(value);
}
function resolveEntryType(entry) {
    return entry.type ?? (entry.command ? "cli" : "provider");
}
export function resolveConfiguredMediaEntryCapabilities(entry) {
    if (!Array.isArray(entry.capabilities)) {
        return undefined;
    }
    const capabilities = entry.capabilities.filter(isMediaCapability);
    return capabilities.length > 0 ? capabilities : undefined;
}
export function resolveEffectiveMediaEntryCapabilities(params) {
    const configured = resolveConfiguredMediaEntryCapabilities(params.entry);
    if (configured) {
        return configured;
    }
    if (params.source !== "shared") {
        return undefined;
    }
    if (resolveEntryType(params.entry) === "cli") {
        return undefined;
    }
    const providerId = normalizeMediaProviderId(params.entry.provider ?? "");
    if (!providerId) {
        return undefined;
    }
    return params.providerRegistry.get(providerId)?.capabilities;
}
export function matchesMediaEntryCapability(params) {
    const capabilities = resolveEffectiveMediaEntryCapabilities(params);
    if (!capabilities || capabilities.length === 0) {
        return params.source === "capability";
    }
    return capabilities.includes(params.capability);
}
