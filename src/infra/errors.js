import { redactSensitiveText } from "../logging/redact.js";
export function extractErrorCode(err) {
    if (!err || typeof err !== "object") {
        return undefined;
    }
    const code = err.code;
    if (typeof code === "string") {
        return code;
    }
    if (typeof code === "number") {
        return String(code);
    }
    return undefined;
}
export function readErrorName(err) {
    if (!err || typeof err !== "object") {
        return "";
    }
    const name = err.name;
    return typeof name === "string" ? name : "";
}
export function collectErrorGraphCandidates(err, resolveNested) {
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
        if (!current || typeof current !== "object" || !resolveNested) {
            continue;
        }
        for (const nested of resolveNested(current)) {
            if (nested != null && !seen.has(nested)) {
                queue.push(nested);
            }
        }
    }
    return candidates;
}
/**
 * Type guard for NodeJS.ErrnoException (any error with a `code` property).
 */
export function isErrno(err) {
    return Boolean(err && typeof err === "object" && "code" in err);
}
/**
 * Check if an error has a specific errno code.
 */
export function hasErrnoCode(err, code) {
    return isErrno(err) && err.code === code;
}
export function formatErrorMessage(err) {
    let formatted;
    if (err instanceof Error) {
        formatted = err.message || err.name || "Error";
        // Traverse .cause chain to include nested error messages (e.g. grammY HttpError wraps network errors in .cause)
        let cause = err.cause;
        const seen = new Set([err]);
        while (cause && !seen.has(cause)) {
            seen.add(cause);
            if (cause instanceof Error) {
                if (cause.message) {
                    formatted += ` | ${cause.message}`;
                }
                cause = cause.cause;
            }
            else if (typeof cause === "string") {
                formatted += ` | ${cause}`;
                break;
            }
            else {
                break;
            }
        }
    }
    else if (typeof err === "string") {
        formatted = err;
    }
    else if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
        formatted = String(err);
    }
    else {
        try {
            formatted = JSON.stringify(err);
        }
        catch {
            formatted = Object.prototype.toString.call(err);
        }
    }
    // Security: best-effort token redaction before returning/logging.
    return redactSensitiveText(formatted);
}
export function formatUncaughtError(err) {
    if (extractErrorCode(err) === "INVALID_CONFIG") {
        return formatErrorMessage(err);
    }
    if (err instanceof Error) {
        const stack = err.stack ?? err.message ?? err.name;
        return redactSensitiveText(stack);
    }
    return formatErrorMessage(err);
}
export function detectErrorKind(err) {
    if (err === undefined) {
        return undefined;
    }
    const message = formatErrorMessage(err).toLowerCase();
    const code = extractErrorCode(err)?.toLowerCase();
    if (message.includes("refusal") ||
        message.includes("content_filter") ||
        message.includes("sensitive") ||
        message.includes("unhandled stop reason: refusal_policy")) {
        return "refusal";
    }
    if (message.includes("timeout") || code === "etimedout" || code === "timeout") {
        return "timeout";
    }
    if (message.includes("rate limit") ||
        message.includes("too many requests") ||
        message.includes("429") ||
        code === "429") {
        return "rate_limit";
    }
    if (message.includes("context length") ||
        message.includes("too many tokens") ||
        message.includes("token limit") ||
        message.includes("context_window")) {
        return "context_length";
    }
    return undefined;
}
