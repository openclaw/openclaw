import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
export function sanitizeTransportPayloadText(text) {
    return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
export function coerceTransportToolCallArguments(argumentsValue) {
    if (argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)) {
        return argumentsValue;
    }
    if (typeof argumentsValue === "string") {
        try {
            const parsed = JSON.parse(argumentsValue);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            // Preserve malformed strings in stored history, but send object-shaped payloads to
            // providers that require structured tool-call arguments.
        }
    }
    return {};
}
export function mergeTransportHeaders(...headerSources) {
    const merged = {};
    for (const headers of headerSources) {
        if (headers) {
            Object.assign(merged, headers);
        }
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
}
export function mergeTransportMetadata(payload, metadata) {
    if (!metadata || Object.keys(metadata).length === 0) {
        return payload;
    }
    const existingMetadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
        ? payload.metadata
        : undefined;
    return {
        ...payload,
        metadata: {
            ...existingMetadata,
            ...metadata,
        },
    };
}
export function createEmptyTransportUsage() {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}
export function createWritableTransportEventStream() {
    const eventStream = createAssistantMessageEventStream();
    return {
        eventStream,
        stream: eventStream,
    };
}
export function finalizeTransportStream(params) {
    const { stream, output, signal } = params;
    if (signal?.aborted) {
        throw new Error("Request was aborted");
    }
    if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error("An unknown error occurred");
    }
    stream.push({ type: "done", reason: output.stopReason, message: output });
    stream.end();
}
export function failTransportStream(params) {
    const { stream, output, signal, error, cleanup } = params;
    cleanup?.();
    output.stopReason = signal?.aborted ? "aborted" : "error";
    output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
    stream.push({ type: "error", reason: output.stopReason, error: output });
    stream.end();
}
