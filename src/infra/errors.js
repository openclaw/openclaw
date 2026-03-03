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
