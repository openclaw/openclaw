import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
export { fetchWithTimeout } from "../../utils/fetch-timeout.js";
const MAX_ERROR_CHARS = 300;
export function normalizeBaseUrl(baseUrl, fallback) {
    const raw = baseUrl?.trim() || fallback;
    return raw.replace(/\/+$/, "");
}
export async function fetchWithTimeoutGuarded(url, init, timeoutMs, fetchFn, options) {
    return await fetchWithSsrFGuard({
        url,
        fetchImpl: fetchFn,
        init,
        timeoutMs,
        policy: options?.ssrfPolicy,
        lookupFn: options?.lookupFn,
        pinDns: options?.pinDns,
    });
}
export async function postTranscriptionRequest(params) {
    return fetchWithTimeoutGuarded(params.url, {
        method: "POST",
        headers: params.headers,
        body: params.body,
    }, params.timeoutMs, params.fetchFn, params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : undefined);
}
export async function readErrorResponse(res) {
    try {
        const text = await res.text();
        const collapsed = text.replace(/\s+/g, " ").trim();
        if (!collapsed) {
            return undefined;
        }
        if (collapsed.length <= MAX_ERROR_CHARS) {
            return collapsed;
        }
        return `${collapsed.slice(0, MAX_ERROR_CHARS)}…`;
    }
    catch {
        return undefined;
    }
}
export async function assertOkOrThrowHttpError(res, label) {
    if (res.ok) {
        return;
    }
    const detail = await readErrorResponse(res);
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`${label} (HTTP ${res.status})${suffix}`);
}
export function requireTranscriptionText(value, missingMessage) {
    const text = value?.trim();
    if (!text) {
        throw new Error(missingMessage);
    }
    return text;
}
