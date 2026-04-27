import path from "node:path";
import { assertOkOrThrowHttpError } from "../agents/provider-http-errors.js";
export { assertOkOrThrowHttpError } from "../agents/provider-http-errors.js";
import { buildProviderRequestDispatcherPolicy, resolveProviderRequestPolicyConfig, } from "../agents/provider-request-config.js";
import { fetchWithSsrFGuard, GUARDED_FETCH_MODE } from "../infra/net/fetch-guard.js";
import { shouldUseEnvHttpProxyForUrl } from "../infra/net/proxy-env.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
export { fetchWithTimeout };
export { normalizeBaseUrl } from "../agents/provider-request-config.js";
export { sanitizeConfiguredModelProviderRequest } from "../agents/provider-request-config.js";
const DEFAULT_GUARDED_HTTP_TIMEOUT_MS = 60_000;
const MAX_ERROR_CHARS = 300;
const MAX_ERROR_RESPONSE_BYTES = 4096;
const MAX_AUDIT_CONTEXT_CHARS = 80;
export function resolveAudioTranscriptionUploadFileName(fileName, mime) {
    const trimmed = fileName?.trim();
    const baseName = trimmed ? path.basename(trimmed) : "audio";
    const lowerMime = mime?.trim().toLowerCase();
    if (/\.aac$/i.test(baseName)) {
        return `${baseName.slice(0, -4) || "audio"}.m4a`;
    }
    if (!path.extname(baseName) && lowerMime === "audio/aac") {
        return `${baseName || "audio"}.m4a`;
    }
    return baseName;
}
export function buildAudioTranscriptionFormData(params) {
    const form = new FormData();
    const bytes = new Uint8Array(params.buffer);
    const blob = new Blob([bytes], {
        type: params.mime ?? "application/octet-stream",
    });
    form.append("file", blob, resolveAudioTranscriptionUploadFileName(params.fileName, params.mime));
    for (const [name, value] of Object.entries(params.fields ?? {})) {
        const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
        if (text) {
            form.append(name, text);
        }
    }
    return form;
}
export function createProviderOperationDeadline(params) {
    if (typeof params.timeoutMs !== "number" ||
        !Number.isFinite(params.timeoutMs) ||
        params.timeoutMs <= 0) {
        return { label: params.label };
    }
    const timeoutMs = Math.floor(params.timeoutMs);
    return {
        deadlineAtMs: Date.now() + timeoutMs,
        label: params.label,
        timeoutMs,
    };
}
export function resolveProviderOperationTimeoutMs(params) {
    const deadlineAtMs = params.deadline.deadlineAtMs;
    if (typeof deadlineAtMs !== "number") {
        return params.defaultTimeoutMs;
    }
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
        throw new Error(`${params.deadline.label} timed out after ${params.deadline.timeoutMs}ms`);
    }
    return Math.max(1, Math.min(params.defaultTimeoutMs, remainingMs));
}
export async function waitProviderOperationPollInterval(params) {
    const deadlineAtMs = params.deadline.deadlineAtMs;
    if (typeof deadlineAtMs !== "number") {
        await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
        return;
    }
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
        throw new Error(`${params.deadline.label} timed out after ${params.deadline.timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(params.pollIntervalMs, remainingMs)));
}
export async function pollProviderOperationJson(params) {
    for (let attempt = 0; attempt < params.maxAttempts; attempt += 1) {
        const response = await fetchWithTimeout(params.url, {
            method: "GET",
            headers: params.headers,
        }, resolveProviderOperationTimeoutMs({
            deadline: params.deadline,
            defaultTimeoutMs: params.defaultTimeoutMs,
        }), params.fetchFn);
        await assertOkOrThrowHttpError(response, params.requestFailedMessage);
        const payload = (await response.json());
        if (params.isComplete(payload)) {
            return payload;
        }
        const failureMessage = params.getFailureMessage?.(payload);
        if (failureMessage) {
            throw new Error(failureMessage);
        }
        await waitProviderOperationPollInterval({
            deadline: params.deadline,
            pollIntervalMs: params.pollIntervalMs,
        });
    }
    throw new Error(params.timeoutMessage);
}
function resolveGuardedHttpTimeoutMs(timeoutMs) {
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return DEFAULT_GUARDED_HTTP_TIMEOUT_MS;
    }
    return timeoutMs;
}
function sanitizeAuditContext(auditContext) {
    const cleaned = auditContext
        ?.replace(/\p{Cc}+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!cleaned) {
        return undefined;
    }
    return cleaned.slice(0, MAX_AUDIT_CONTEXT_CHARS);
}
export function resolveProviderHttpRequestConfig(params) {
    const requestConfig = resolveProviderRequestPolicyConfig({
        provider: params.provider ?? "",
        baseUrl: params.baseUrl,
        defaultBaseUrl: params.defaultBaseUrl,
        capability: params.capability ?? "other",
        transport: params.transport ?? "http",
        callerHeaders: params.headers
            ? Object.fromEntries(new Headers(params.headers).entries())
            : undefined,
        providerHeaders: params.defaultHeaders,
        precedence: "caller-wins",
        allowPrivateNetwork: params.allowPrivateNetwork,
        api: params.api,
        request: params.request,
    });
    const headers = new Headers(requestConfig.headers);
    if (!requestConfig.baseUrl) {
        throw new Error("Missing baseUrl: provide baseUrl or defaultBaseUrl");
    }
    return {
        baseUrl: requestConfig.baseUrl,
        allowPrivateNetwork: requestConfig.allowPrivateNetwork,
        headers,
        dispatcherPolicy: buildProviderRequestDispatcherPolicy(requestConfig),
        requestConfig,
    };
}
/**
 * Decide whether to auto-upgrade a provider HTTP request into
 * `TRUSTED_ENV_PROXY` mode based on the runtime environment.
 *
 * This is gated conservatively to avoid the SSRF bypasses the initial
 * auto-upgrade path exposed (see openclaw#64974 review threads):
 *
 * 1. If the caller supplied an explicit `dispatcherPolicy` — custom proxy URL,
 *    `proxyTls`, or `connect` options — do NOT override it. Trusted-env mode
 *    builds an `EnvHttpProxyAgent` that would silently drop those overrides,
 *    breaking enterprise proxy/mTLS configs.
 *
 * 2. Only auto-upgrade when `HTTP_PROXY` or `HTTPS_PROXY` (lower- or
 *    upper-case) is configured for the target protocol. `ALL_PROXY` is
 *    explicitly ignored by `EnvHttpProxyAgent`, so counting it would
 *    auto-upgrade requests that then make direct connections while skipping
 *    pinned-DNS/SSRF hostname checks.
 *
 * 3. If `NO_PROXY` would bypass the proxy for this target, do NOT auto-upgrade.
 *    `EnvHttpProxyAgent` makes direct connections for `NO_PROXY` matches, but
 *    in `TRUSTED_ENV_PROXY` mode `fetchWithSsrFGuard` skips
 *    `resolvePinnedHostnameWithPolicy` — so those direct connections would
 *    bypass SSRF protection. Keep strict mode for `NO_PROXY` matches.
 */
function shouldAutoUpgradeToTrustedEnvProxy(params) {
    if (params.dispatcherPolicy) {
        return false;
    }
    return shouldUseEnvHttpProxyForUrl(params.url);
}
export async function fetchWithTimeoutGuarded(url, init, timeoutMs, fetchFn, options) {
    // Provider HTTP helpers (image/music/video generation, transcription, etc.)
    // call this function from every provider that talks to a remote API. When
    // the host has HTTP_PROXY/HTTPS_PROXY configured, the lower-level strict
    // mode would force Node-level `dns.lookup()` on the target hostname before
    // dialing the proxy — which fails with EAI_AGAIN in proxy-only environments
    // (containers, restricted sandboxes, corporate networks with DNS-over-proxy,
    // Clash TUN fake-IP, etc.). Auto-upgrade to trusted env proxy mode in that
    // case so the request goes through the configured proxy agent instead of
    // doing a local DNS pre-resolution.
    //
    // This does not weaken SSRF protection when the auto-upgrade fires: an HTTP
    // CONNECT proxy on the egress path performs hostname resolution itself and
    // client-side DNS pinning cannot meaningfully constrain the target IP. But
    // the auto-upgrade is gated (see `shouldAutoUpgradeToTrustedEnvProxy`) to
    // avoid three SSRF-bypass edge cases: caller-provided `dispatcherPolicy`,
    // `ALL_PROXY`-only envs, and `NO_PROXY` target matches. Callers that
    // explicitly need strict pinned-DNS can still opt in by passing
    // `mode: GUARDED_FETCH_MODE.STRICT` here or by using `fetchWithSsrFGuard`
    // directly.
    //
    // See openclaw#52162 for the reported failure mode on memory embeddings,
    // which shares this code path with image/music/video/audio generation.
    const resolvedMode = options?.mode ??
        (shouldAutoUpgradeToTrustedEnvProxy({
            url,
            dispatcherPolicy: options?.dispatcherPolicy,
        })
            ? GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY
            : undefined);
    return await fetchWithSsrFGuard({
        url,
        fetchImpl: fetchFn,
        init,
        timeoutMs: resolveGuardedHttpTimeoutMs(timeoutMs),
        policy: options?.ssrfPolicy,
        lookupFn: options?.lookupFn,
        pinDns: options?.pinDns,
        dispatcherPolicy: options?.dispatcherPolicy,
        auditContext: sanitizeAuditContext(options?.auditContext),
        ...(resolvedMode ? { mode: resolvedMode } : {}),
    });
}
function resolveGuardedPostRequestOptions(params) {
    if (!params.allowPrivateNetwork &&
        !params.dispatcherPolicy &&
        params.pinDns === undefined &&
        !params.auditContext &&
        params.mode === undefined) {
        return undefined;
    }
    return {
        ...(params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
        ...(params.pinDns !== undefined ? { pinDns: params.pinDns } : {}),
        ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {}),
        ...(params.auditContext ? { auditContext: params.auditContext } : {}),
        ...(params.mode !== undefined ? { mode: params.mode } : {}),
    };
}
export async function postTranscriptionRequest(params) {
    return fetchWithTimeoutGuarded(params.url, {
        method: "POST",
        headers: params.headers,
        body: params.body,
    }, params.timeoutMs, params.fetchFn, resolveGuardedPostRequestOptions(params));
}
export async function postJsonRequest(params) {
    return fetchWithTimeoutGuarded(params.url, {
        method: "POST",
        headers: params.headers,
        body: JSON.stringify(params.body),
    }, params.timeoutMs, params.fetchFn, resolveGuardedPostRequestOptions(params));
}
export async function postMultipartRequest(params) {
    return fetchWithTimeoutGuarded(params.url, {
        method: "POST",
        headers: params.headers,
        body: params.body,
    }, params.timeoutMs, params.fetchFn, resolveGuardedPostRequestOptions(params));
}
export async function readErrorResponse(res) {
    let reader;
    try {
        if (!res.body) {
            return undefined;
        }
        reader = res.body.getReader();
        const chunks = [];
        let total = 0;
        let sawBytes = false;
        while (total < MAX_ERROR_RESPONSE_BYTES) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (!value || value.length === 0) {
                continue;
            }
            sawBytes = true;
            const remaining = MAX_ERROR_RESPONSE_BYTES - total;
            const chunk = value.length <= remaining ? value : value.subarray(0, remaining);
            chunks.push(chunk);
            total += chunk.length;
            if (chunk.length < value.length) {
                break;
            }
        }
        if (!sawBytes) {
            return undefined;
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        const text = new TextDecoder().decode(bytes);
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
    finally {
        try {
            await reader?.cancel();
        }
        catch {
            // Ignore stream-cancel failures while reporting the original HTTP error.
        }
    }
}
export function requireTranscriptionText(value, missingMessage) {
    const text = value?.trim();
    if (!text) {
        throw new Error(missingMessage);
    }
    return text;
}
