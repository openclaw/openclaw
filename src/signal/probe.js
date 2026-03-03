import { signalCheck, signalRpcRequest } from "./client.js";
function parseSignalVersion(value) {
    if (typeof value === "string" && value.trim()) {
        return value.trim();
    }
    if (typeof value === "object" && value !== null) {
        const version = value.version;
        if (typeof version === "string" && version.trim()) {
            return version.trim();
        }
    }
    return null;
}
export async function probeSignal(baseUrl, timeoutMs) {
    const started = Date.now();
    const result = {
        ok: false,
        status: null,
        error: null,
        elapsedMs: 0,
        version: null,
    };
    const check = await signalCheck(baseUrl, timeoutMs);
    if (!check.ok) {
        return {
            ...result,
            status: check.status ?? null,
            error: check.error ?? "unreachable",
            elapsedMs: Date.now() - started,
        };
    }
    try {
        const version = await signalRpcRequest("version", undefined, {
            baseUrl,
            timeoutMs,
        });
        result.version = parseSignalVersion(version);
    }
    catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
    }
    return {
        ...result,
        ok: true,
        status: check.status ?? null,
        elapsedMs: Date.now() - started,
    };
}
