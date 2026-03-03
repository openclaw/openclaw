import { mapStreamingModeToSlackLegacyDraftStreamMode, resolveSlackNativeStreaming, resolveSlackStreamingMode, } from "../config/discord-preview-streaming.js";
const DEFAULT_STREAM_MODE = "replace";
export function resolveSlackStreamMode(raw) {
    if (typeof raw !== "string") {
        return DEFAULT_STREAM_MODE;
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized === "replace" || normalized === "status_final" || normalized === "append") {
        return normalized;
    }
    return DEFAULT_STREAM_MODE;
}
export function resolveSlackStreamingConfig(params) {
    const mode = resolveSlackStreamingMode(params);
    const nativeStreaming = resolveSlackNativeStreaming(params);
    return {
        mode,
        nativeStreaming,
        draftMode: mapStreamingModeToSlackLegacyDraftStreamMode(mode),
    };
}
export function applyAppendOnlyStreamUpdate(params) {
    const incoming = params.incoming.trimEnd();
    if (!incoming) {
        return { rendered: params.rendered, source: params.source, changed: false };
    }
    if (!params.rendered) {
        return { rendered: incoming, source: incoming, changed: true };
    }
    if (incoming === params.source) {
        return { rendered: params.rendered, source: params.source, changed: false };
    }
    // Typical model partials are cumulative prefixes.
    if (incoming.startsWith(params.source) || incoming.startsWith(params.rendered)) {
        return { rendered: incoming, source: incoming, changed: incoming !== params.rendered };
    }
    // Ignore regressive shorter variants of the same stream.
    if (params.source.startsWith(incoming)) {
        return { rendered: params.rendered, source: params.source, changed: false };
    }
    const separator = params.rendered.endsWith("\n") ? "" : "\n";
    return {
        rendered: `${params.rendered}${separator}${incoming}`,
        source: incoming,
        changed: true,
    };
}
export function buildStatusFinalPreviewText(updateCount) {
    const dots = ".".repeat((Math.max(1, updateCount) % 3) + 1);
    return `Status: thinking${dots}`;
}
