import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
function asObjectRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function asTextChunkMode(value) {
    return value === "length" || value === "newline" ? value : undefined;
}
function asBoolean(value) {
    return typeof value === "boolean" ? value : undefined;
}
function normalizeStreamingMode(value) {
    if (typeof value !== "string") {
        return null;
    }
    const normalized = normalizeOptionalLowercaseString(value);
    return normalized || null;
}
function parsePreviewStreamingMode(value) {
    const normalized = normalizeStreamingMode(value);
    if (normalized === "off" ||
        normalized === "partial" ||
        normalized === "block" ||
        normalized === "progress") {
        return normalized === "progress" ? "partial" : normalized;
    }
    return null;
}
function asBlockStreamingCoalesceConfig(value) {
    return asObjectRecord(value);
}
function asBlockStreamingChunkConfig(value) {
    return asObjectRecord(value);
}
export function getChannelStreamingConfigObject(entry) {
    const streaming = asObjectRecord(entry?.streaming);
    return streaming ? streaming : undefined;
}
export function resolveChannelStreamingChunkMode(entry) {
    return (asTextChunkMode(getChannelStreamingConfigObject(entry)?.chunkMode) ??
        asTextChunkMode(entry?.chunkMode));
}
export function resolveChannelStreamingBlockEnabled(entry) {
    const config = getChannelStreamingConfigObject(entry);
    return asBoolean(config?.block?.enabled) ?? asBoolean(entry?.blockStreaming);
}
export function resolveChannelStreamingBlockCoalesce(entry) {
    const config = getChannelStreamingConfigObject(entry);
    return (asBlockStreamingCoalesceConfig(config?.block?.coalesce) ??
        asBlockStreamingCoalesceConfig(entry?.blockStreamingCoalesce));
}
export function resolveChannelStreamingPreviewChunk(entry) {
    const config = getChannelStreamingConfigObject(entry);
    return (asBlockStreamingChunkConfig(config?.preview?.chunk) ??
        asBlockStreamingChunkConfig(entry?.draftChunk));
}
export function resolveChannelStreamingPreviewToolProgress(entry, defaultValue = true) {
    const config = getChannelStreamingConfigObject(entry);
    return asBoolean(config?.preview?.toolProgress) ?? defaultValue;
}
export function resolveChannelStreamingNativeTransport(entry) {
    const config = getChannelStreamingConfigObject(entry);
    return asBoolean(config?.nativeTransport) ?? asBoolean(entry?.nativeStreaming);
}
export function resolveChannelPreviewStreamMode(entry, defaultMode) {
    const parsedStreaming = parsePreviewStreamingMode(getChannelStreamingConfigObject(entry)?.mode ?? entry?.streaming);
    if (parsedStreaming) {
        return parsedStreaming;
    }
    const legacy = parsePreviewStreamingMode(entry?.streamMode);
    if (legacy) {
        return legacy;
    }
    if (typeof entry?.streaming === "boolean") {
        return entry.streaming ? "partial" : "off";
    }
    return defaultMode;
}
