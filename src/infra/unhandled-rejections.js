import process from "node:process";
import { extractErrorCode, formatUncaughtError } from "./errors.js";
const handlers = new Set();
const FATAL_ERROR_CODES = new Set([
    "ERR_OUT_OF_MEMORY",
    "ERR_SCRIPT_EXECUTION_TIMEOUT",
    "ERR_WORKER_OUT_OF_MEMORY",
    "ERR_WORKER_UNCAUGHT_EXCEPTION",
    "ERR_WORKER_INITIALIZATION_FAILED",
]);
const CONFIG_ERROR_CODES = new Set(["INVALID_CONFIG", "MISSING_API_KEY", "MISSING_CREDENTIALS"]);
// Network error codes that indicate transient failures (shouldn't crash the gateway)
const TRANSIENT_NETWORK_CODES = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "ETIMEDOUT",
    "ESOCKETTIMEDOUT",
    "ECONNABORTED",
    "EPIPE",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_DNS_RESOLVE_FAILED",
    "UND_ERR_CONNECT",
    "UND_ERR_SOCKET",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
]);
const TRANSIENT_NETWORK_ERROR_NAMES = new Set([
    "AbortError",
    "ConnectTimeoutError",
    "HeadersTimeoutError",
    "BodyTimeoutError",
    "TimeoutError",
]);
const TRANSIENT_NETWORK_MESSAGE_CODE_RE = /\b(ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|EPIPE|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_DNS_RESOLVE_FAILED|UND_ERR_CONNECT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)\b/i;
const TRANSIENT_NETWORK_MESSAGE_SNIPPETS = [
    "getaddrinfo",
    "socket hang up",
    "client network socket disconnected before secure tls connection was established",
    "network error",
    "network is unreachable",
    "temporary failure in name resolution",
];
function getErrorCause(err) {
    if (!err || typeof err !== "object") {
        return undefined;
    }
    return err.cause;
}
function getErrorName(err) {
    if (!err || typeof err !== "object") {
        return "";
    }
    const name = err.name;
    return typeof name === "string" ? name : "";
}
function extractErrorCodeOrErrno(err) {
    const code = extractErrorCode(err);
    if (code) {
        return code.trim().toUpperCase();
    }
    if (!err || typeof err !== "object") {
        return undefined;
    }
    const errno = err.errno;
    if (typeof errno === "string" && errno.trim()) {
        return errno.trim().toUpperCase();
    }
    if (typeof errno === "number" && Number.isFinite(errno)) {
        return String(errno);
    }
    return undefined;
}
function extractErrorCodeWithCause(err) {
    const direct = extractErrorCode(err);
    if (direct) {
        return direct;
    }
    return extractErrorCode(getErrorCause(err));
}
function collectErrorCandidates(err) {
    const queue = [err];
    const seen = new Set();
    const candidates = [];
    while (queue.length > 0) {
        const current = queue.shift();
        if (current == null || seen.has(current)) {
            continue;
        }
        seen.add(current);
        candidates.push(current);
        if (!current || typeof current !== "object") {
            continue;
        }
        const maybeNested = [
            current.cause,
            current.reason,
            current.original,
            current.error,
            current.data,
        ];
        const errors = current.errors;
        if (Array.isArray(errors)) {
            maybeNested.push(...errors);
        }
        for (const nested of maybeNested) {
            if (nested != null && !seen.has(nested)) {
                queue.push(nested);
            }
        }
    }
    return candidates;
}
/**
 * Checks if an error is an AbortError.
 * These are typically intentional cancellations (e.g., during shutdown) and shouldn't crash.
 */
export function isAbortError(err) {
    if (!err || typeof err !== "object") {
        return false;
    }
    const name = "name" in err ? String(err.name) : "";
    if (name === "AbortError") {
        return true;
    }
    // Check for "This operation was aborted" message from Node's undici
    const message = "message" in err && typeof err.message === "string" ? err.message : "";
    if (message === "This operation was aborted") {
        return true;
    }
    return false;
}
function isFatalError(err) {
    const code = extractErrorCodeWithCause(err);
    return code !== undefined && FATAL_ERROR_CODES.has(code);
}
function isConfigError(err) {
    const code = extractErrorCodeWithCause(err);
    return code !== undefined && CONFIG_ERROR_CODES.has(code);
}
/**
 * Checks if an error is a transient network error that shouldn't crash the gateway.
 * These are typically temporary connectivity issues that will resolve on their own.
 */
export function isTransientNetworkError(err) {
    if (!err) {
        return false;
    }
    for (const candidate of collectErrorCandidates(err)) {
        const code = extractErrorCodeOrErrno(candidate);
        if (code && TRANSIENT_NETWORK_CODES.has(code)) {
            return true;
        }
        const name = getErrorName(candidate);
        if (name && TRANSIENT_NETWORK_ERROR_NAMES.has(name)) {
            return true;
        }
        if (candidate instanceof TypeError && candidate.message === "fetch failed") {
            return true;
        }
        if (!candidate || typeof candidate !== "object") {
            continue;
        }
        const rawMessage = candidate.message;
        const message = typeof rawMessage === "string" ? rawMessage.toLowerCase().trim() : "";
        if (!message) {
            continue;
        }
        if (TRANSIENT_NETWORK_MESSAGE_CODE_RE.test(message)) {
            return true;
        }
        if (message === "fetch failed") {
            return true;
        }
        if (TRANSIENT_NETWORK_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) {
            return true;
        }
    }
    return false;
}
export function registerUnhandledRejectionHandler(handler) {
    handlers.add(handler);
    return () => {
        handlers.delete(handler);
    };
}
export function isUnhandledRejectionHandled(reason) {
    for (const handler of handlers) {
        try {
            if (handler(reason)) {
                return true;
            }
        }
        catch (err) {
            console.error("[openclaw] Unhandled rejection handler failed:", err instanceof Error ? (err.stack ?? err.message) : err);
        }
    }
    return false;
}
export function installUnhandledRejectionHandler() {
    process.on("unhandledRejection", (reason, _promise) => {
        if (isUnhandledRejectionHandled(reason)) {
            return;
        }
        // AbortError is typically an intentional cancellation (e.g., during shutdown)
        // Log it but don't crash - these are expected during graceful shutdown
        if (isAbortError(reason)) {
            console.warn("[openclaw] Suppressed AbortError:", formatUncaughtError(reason));
            return;
        }
        if (isFatalError(reason)) {
            console.error("[openclaw] FATAL unhandled rejection:", formatUncaughtError(reason));
            process.exit(1);
            return;
        }
        if (isConfigError(reason)) {
            console.error("[openclaw] CONFIGURATION ERROR - requires fix:", formatUncaughtError(reason));
            process.exit(1);
            return;
        }
        if (isTransientNetworkError(reason)) {
            console.warn("[openclaw] Non-fatal unhandled rejection (continuing):", formatUncaughtError(reason));
            return;
        }
        console.error("[openclaw] Unhandled promise rejection:", formatUncaughtError(reason));
        process.exit(1);
    });
}
