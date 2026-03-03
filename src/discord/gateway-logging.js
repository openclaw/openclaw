import { logVerbose } from "../globals.js";
const INFO_DEBUG_MARKERS = [
    "WebSocket connection closed",
    "Reconnecting with backoff",
    "Attempting resume with backoff",
];
const shouldPromoteGatewayDebug = (message) => INFO_DEBUG_MARKERS.some((marker) => message.includes(marker));
const formatGatewayMetrics = (metrics) => {
    if (metrics === null || metrics === undefined) {
        return String(metrics);
    }
    if (typeof metrics === "string") {
        return metrics;
    }
    if (typeof metrics === "number" || typeof metrics === "boolean" || typeof metrics === "bigint") {
        return String(metrics);
    }
    try {
        return JSON.stringify(metrics);
    }
    catch {
        return "[unserializable metrics]";
    }
};
export function attachDiscordGatewayLogging(params) {
    const { emitter, runtime } = params;
    if (!emitter) {
        return () => { };
    }
    const onGatewayDebug = (msg) => {
        const message = String(msg);
        logVerbose(`discord gateway: ${message}`);
        if (shouldPromoteGatewayDebug(message)) {
            runtime.log?.(`discord gateway: ${message}`);
        }
    };
    const onGatewayWarning = (warning) => {
        logVerbose(`discord gateway warning: ${String(warning)}`);
    };
    const onGatewayMetrics = (metrics) => {
        logVerbose(`discord gateway metrics: ${formatGatewayMetrics(metrics)}`);
    };
    emitter.on("debug", onGatewayDebug);
    emitter.on("warning", onGatewayWarning);
    emitter.on("metrics", onGatewayMetrics);
    return () => {
        emitter.removeListener("debug", onGatewayDebug);
        emitter.removeListener("warning", onGatewayWarning);
        emitter.removeListener("metrics", onGatewayMetrics);
    };
}
