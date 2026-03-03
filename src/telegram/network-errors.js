import { extractErrorCode, formatErrorMessage } from "../infra/errors.js";
const RECOVERABLE_ERROR_CODES = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ETIMEDOUT",
    "ESOCKETTIMEDOUT",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
    "UND_ERR_ABORTED",
    "ECONNABORTED",
    "ERR_NETWORK",
]);
const RECOVERABLE_ERROR_NAMES = new Set([
    "AbortError",
    "TimeoutError",
    "ConnectTimeoutError",
    "HeadersTimeoutError",
    "BodyTimeoutError",
]);
const ALWAYS_RECOVERABLE_MESSAGES = new Set(["fetch failed", "typeerror: fetch failed"]);
const RECOVERABLE_MESSAGE_SNIPPETS = [
    "undici",
    "network error",
    "network request",
    "client network socket disconnected",
    "socket hang up",
    "getaddrinfo",
    "timeout", // catch timeout messages not covered by error codes/names
    "timed out", // grammY getUpdates returns "timed out after X seconds" (not matched by "timeout")
];
function normalizeCode(code) {
    return code?.trim().toUpperCase() ?? "";
}
function getErrorName(err) {
    if (!err || typeof err !== "object") {
        return "";
    }
    return "name" in err ? String(err.name) : "";
}
function getErrorCode(err) {
    const direct = extractErrorCode(err);
    if (direct) {
        return direct;
    }
    if (!err || typeof err !== "object") {
        return undefined;
    }
    const errno = err.errno;
    if (typeof errno === "string") {
        return errno;
    }
    if (typeof errno === "number") {
        return String(errno);
    }
    return undefined;
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
        if (typeof current === "object") {
            const cause = current.cause;
            if (cause && !seen.has(cause)) {
                queue.push(cause);
            }
            const reason = current.reason;
            if (reason && !seen.has(reason)) {
                queue.push(reason);
            }
            const errors = current.errors;
            if (Array.isArray(errors)) {
                for (const nested of errors) {
                    if (nested && !seen.has(nested)) {
                        queue.push(nested);
                    }
                }
            }
            // Grammy's HttpError wraps the underlying error in .error (not .cause)
            // Only follow .error for HttpError to avoid widening the search graph
            if (getErrorName(current) === "HttpError") {
                const wrappedError = current.error;
                if (wrappedError && !seen.has(wrappedError)) {
                    queue.push(wrappedError);
                }
            }
        }
    }
    return candidates;
}
export function isRecoverableTelegramNetworkError(err, options = {}) {
    if (!err) {
        return false;
    }
    const allowMessageMatch = typeof options.allowMessageMatch === "boolean"
        ? options.allowMessageMatch
        : options.context !== "send";
    for (const candidate of collectErrorCandidates(err)) {
        const code = normalizeCode(getErrorCode(candidate));
        if (code && RECOVERABLE_ERROR_CODES.has(code)) {
            return true;
        }
        const name = getErrorName(candidate);
        if (name && RECOVERABLE_ERROR_NAMES.has(name)) {
            return true;
        }
        const message = formatErrorMessage(candidate).trim().toLowerCase();
        if (message && ALWAYS_RECOVERABLE_MESSAGES.has(message)) {
            return true;
        }
        if (allowMessageMatch && message) {
            if (RECOVERABLE_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) {
                return true;
            }
        }
    }
    return false;
}
